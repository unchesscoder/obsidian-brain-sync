# Push Stale-State Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `brain push` bricht ab, statt Remote-Dateien zu löschen oder zurückzudrehen, die dieses Gerät nie gepullt hat.

**Architecture:** Die Entscheidungslogik kommt als reine Funktion `detectStalePush` in ein neues Modul `lib/stale-guard.mjs` — kein Dateisystem, kein Git, kein Zustand, damit direkt unit-testbar. `lib/brain-sync.mjs` importiert sie und ruft sie in `cmdPush` auf, bevor der Mirror gelöscht wird. Ein Traversal-Helfer sammelt die lokale Dateiliste mit derselben Skip-Logik, die auch `copyTree` verwendet.

**Tech Stack:** Reines Node (ESM, `.mjs`), keine externen Abhängigkeiten, kein Test-Framework. Tests sind Node-Skripte mit eigenem `ok()`-Zähler.

## Global Constraints

- Keine externen Dependencies. Nur `node:`-Builtins.
- Cross-platform (Windows/macOS/Linux). Pfadvergleiche immer über `/`-normalisierte Relativpfade, nie `path.sep`.
- Kein `jq`, keine Shell-Pipelines in Tests — JSON in Node parsen.
- Ausgabetexte auf Deutsch, **ohne Umlaute** (bestehende Konvention der Engine: „uebersprungen", „geloescht", „ABGEBROCHEN").
- Commit-Messages auf Englisch, konventionelles Format (`feat:`, `fix:`, `docs:`, `test:`).
- `MTIME_TOLERANCE_MS = 2000` — ein einziger Ort, importiert von allen Nutzern.
- Leitprinzip: im Zweifel blockieren. Jeder nicht eindeutig sichere Zustand bricht ab.

## File Structure

| Datei | Verantwortung |
|---|---|
| `lib/stale-guard.mjs` (neu) | Reine Entscheidungslogik: `detectStalePush`, `MTIME_TOLERANCE_MS`, `formatStaleReport` |
| `lib/brain-sync.mjs` (ändern) | Import, Traversal-Helfer, Aufruf in `cmdPush`, Toleranz in `cmdPull` |
| `tests/stale-guard-test.mjs` (neu) | Unit-Tests der reinen Funktion |
| `tests/sandbox-test.mjs` (ändern) | Integrationstests gegen das lokale Bare-Repo |
| `skills/brain-push/SKILL.md` (ändern) | `--allow-stale` dokumentieren, Abbruch erklären |
| `README.md`, `CHANGELOG.md` (ändern) | Feature dokumentieren |

---

### Task 1: Reine Entscheidungslogik `detectStalePush`

**Files:**
- Create: `lib/stale-guard.mjs`
- Test: `tests/stale-guard-test.mjs`

**Interfaces:**
- Consumes: nichts (erste Task)
- Produces:
  - `MTIME_TOLERANCE_MS: number` (= 2000)
  - `detectStalePush({ remoteFiles, localFiles, baseline, manifestVault, indexPath }) -> { deletions, reversions, unsafe, blocked }`
    - `remoteFiles: string[]` — `/`-normalisierte Relativpfade im Remote-Mirror
    - `localFiles: string[]` — `/`-normalisierte Relativpfade, die gespiegelt würden
    - `baseline: { files: Record<string, number> } | null` — `null` = noch nie gesynct
    - `manifestVault: Record<string, { mtime: number, size: number }>`
    - `indexPath: string` — z. B. `"Claude Sessions.md"`, wird ignoriert
    - `deletions: Array<{ rel, grund: "nie-gepullt" | "remote-geaendert" }>`
    - `reversions: Array<{ rel, localMtime, remoteMtime }>`
    - `unsafe: Array<{ rel, grund: string }>`
    - `blocked: boolean` — true, wenn eine der drei Listen nicht leer ist
  - `formatStaleReport(result) -> string` — der Abbruchtext

- [ ] **Step 1: Write the failing test**

Create `tests/stale-guard-test.mjs`:

```js
// Unit tests for the pure stale-push detection logic.
// Run: node tests/stale-guard-test.mjs

import { detectStalePush, MTIME_TOLERANCE_MS, formatStaleReport } from "../lib/stale-guard.mjs";

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log("  PASS " + msg); } else { fail++; console.log("  FAIL " + msg); } }

const T = 1_000_000_000_000; // fixed base timestamp

// 1. deletion WITH baseline entry, remote unchanged -> allowed
{
  const r = detectStalePush({
    remoteFiles: ["a.md"],
    localFiles: [],
    baseline: { files: { "a.md": T } },
    manifestVault: { "a.md": { mtime: T, size: 1 } },
    indexPath: "Claude Sessions.md",
  });
  ok(!r.blocked, "bewusste Loeschung wird durchgelassen");
}

// 2. deletion WITHOUT baseline entry -> blocked as never-pulled
{
  const r = detectStalePush({
    remoteFiles: ["a.md"],
    localFiles: [],
    baseline: { files: {} },
    manifestVault: { "a.md": { mtime: T, size: 1 } },
    indexPath: "Claude Sessions.md",
  });
  ok(r.blocked, "Loeschung ohne Baseline-Eintrag blockiert");
  ok(r.deletions.length === 1 && r.deletions[0].grund === "nie-gepullt", "Grund ist nie-gepullt");
}

// 2b. deletion with baseline entry BUT remote moved on -> blocked
{
  const r = detectStalePush({
    remoteFiles: ["a.md"],
    localFiles: [],
    baseline: { files: { "a.md": T } },
    manifestVault: { "a.md": { mtime: T + 60_000, size: 1 } },
    indexPath: "Claude Sessions.md",
  });
  ok(r.blocked, "Loeschung blockiert, wenn Remote seit dem Sync geaendert wurde");
  ok(r.deletions[0].grund === "remote-geaendert", "Grund ist remote-geaendert");
}

// 3. local older than remote -> reversion
{
  const r = detectStalePush({
    remoteFiles: ["a.md"],
    localFiles: ["a.md"],
    localMtimes: { "a.md": T },
    baseline: { files: { "a.md": T } },
    manifestVault: { "a.md": { mtime: T + 60_000, size: 1 } },
    indexPath: "Claude Sessions.md",
  });
  ok(r.blocked && r.reversions.length === 1, "aeltere lokale Datei wird als Rueckdrehung erkannt");
  ok(r.reversions[0].remoteMtime === T + 60_000, "Rueckdrehung meldet die Remote-mtime");
}

// 4. difference below tolerance -> allowed (the utimesSync rounding case)
{
  const r = detectStalePush({
    remoteFiles: ["a.md"],
    localFiles: ["a.md"],
    localMtimes: { "a.md": T },
    baseline: { files: { "a.md": T } },
    manifestVault: { "a.md": { mtime: T + MTIME_TOLERANCE_MS - 1, size: 1 } },
    indexPath: "Claude Sessions.md",
  });
  ok(!r.blocked, "mtime-Differenz unter der Toleranz blockiert nicht");
}

// 5. local file present but no manifest record -> unsafe
{
  const r = detectStalePush({
    remoteFiles: ["a.md"],
    localFiles: ["a.md"],
    localMtimes: { "a.md": T },
    baseline: { files: { "a.md": T } },
    manifestVault: {},
    indexPath: "Claude Sessions.md",
  });
  ok(r.blocked && r.unsafe.length === 1, "fehlender Manifest-Eintrag gilt als unsicher");
}

// 6. the session index is never reported
{
  const r = detectStalePush({
    remoteFiles: ["Claude Sessions.md"],
    localFiles: [],
    baseline: { files: {} },
    manifestVault: { "Claude Sessions.md": { mtime: T, size: 1 } },
    indexPath: "Claude Sessions.md",
  });
  ok(!r.blocked, "Session-Index wird von der Pruefung ausgenommen");
}

// 7. empty remote -> nothing to report (first push into an empty repo)
{
  const r = detectStalePush({
    remoteFiles: [], localFiles: ["a.md"], baseline: null, manifestVault: {}, indexPath: "Claude Sessions.md",
  });
  ok(!r.blocked, "leeres Remote erzeugt keinen Fehlalarm");
}

// 8. no baseline at all -> every remote file counts as never-pulled
{
  const r = detectStalePush({
    remoteFiles: ["a.md", "b.md"],
    localFiles: [],
    baseline: null,
    manifestVault: { "a.md": { mtime: T, size: 1 }, "b.md": { mtime: T, size: 1 } },
    indexPath: "Claude Sessions.md",
  });
  ok(r.blocked && r.deletions.length === 2, "fehlende Baseline blockiert alle Remote-Dateien");
}

// 9. report text mentions counts and the pull hint
{
  const r = detectStalePush({
    remoteFiles: ["a.md"], localFiles: [], baseline: { files: {} },
    manifestVault: { "a.md": { mtime: T, size: 1 } }, indexPath: "Claude Sessions.md",
  });
  const txt = formatStaleReport(r);
  ok(/ABGEBROCHEN/.test(txt) && /brain pull/.test(txt) && /--allow-stale/.test(txt),
     "Report nennt Abbruch, Pull-Hinweis und Override-Flag");
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/stale-guard-test.mjs`
Expected: FAIL — `Cannot find module .../lib/stale-guard.mjs`

- [ ] **Step 3: Write minimal implementation**

Create `lib/stale-guard.mjs`:

```js
// Pure decision logic for the push stale-state guard.
// No filesystem, no git, no state - everything comes in as plain data.
//
// The push mirrors the local vault into the remote. A device that never pulled
// would silently delete files it could not know about and revert others to older
// versions. This module decides whether that is about to happen.

// NTFS stores 100ns ticks while JS Date carries milliseconds, so a restored
// mtime reads back marginally different. FAT32 is granular to 2s. The pull uses
// the same tolerance for its delete check.
export const MTIME_TOLERANCE_MS = 2000;

/**
 * @returns {{deletions: Array, reversions: Array, unsafe: Array, blocked: boolean}}
 */
export function detectStalePush({ remoteFiles, localFiles, localMtimes, baseline, manifestVault, indexPath }) {
  const local = new Set(localFiles || []);
  const lm = localMtimes || {};
  const baseFiles = (baseline && baseline.files) || null;
  const mv = manifestVault || {};
  const idx = (indexPath || "").split(/[\\/]/).join("/");

  const deletions = [], reversions = [], unsafe = [];

  for (const rel of remoteFiles || []) {
    if (rel === idx) continue; // written by the push itself, never a real divergence

    const remoteRec = mv[rel];

    if (!local.has(rel)) {
      // the file would vanish from the remote
      if (!baseFiles || !(rel in baseFiles)) {
        deletions.push({ rel, grund: "nie-gepullt" });
      } else if (remoteRec && Math.abs(remoteRec.mtime - baseFiles[rel]) > MTIME_TOLERANCE_MS) {
        // we last saw an older version; someone changed it since -> not our call
        deletions.push({ rel, grund: "remote-geaendert" });
      }
      continue;
    }

    // the file exists locally and would overwrite the remote copy
    if (!remoteRec || typeof remoteRec.mtime !== "number") {
      unsafe.push({ rel, grund: "kein Manifest-Eintrag" });
      continue;
    }
    const localMtime = rel in lm ? lm[rel] : null;
    if (localMtime !== null && localMtime < remoteRec.mtime - MTIME_TOLERANCE_MS) {
      reversions.push({ rel, localMtime, remoteMtime: remoteRec.mtime });
    }
  }

  return { deletions, reversions, unsafe, blocked: !!(deletions.length || reversions.length || unsafe.length) };
}

export function formatStaleReport(r) {
  const lines = ["", "Push ABGEBROCHEN: dieses Geraet hat einen veralteten Stand.", ""];
  const list = (arr, fmt) => {
    for (const e of arr.slice(0, 25)) lines.push("    - " + fmt(e));
    if (arr.length > 25) lines.push(`    ... und ${arr.length - 25} weitere`);
  };
  if (r.deletions.length) {
    lines.push(`  ${r.deletions.length} Dateien wuerden GELOESCHT:`);
    list(r.deletions, (e) => `${e.rel}  (${e.grund})`);
    lines.push("");
  }
  if (r.reversions.length) {
    lines.push(`  ${r.reversions.length} Dateien wuerden ZURUECKGEDREHT (remote ist neuer):`);
    list(r.reversions, (e) => `${e.rel}  remote ${new Date(e.remoteMtime).toISOString()} > lokal ${new Date(e.localMtime).toISOString()}`);
    lines.push("");
  }
  if (r.unsafe.length) {
    lines.push(`  ${r.unsafe.length} Dateien mit unklarem Zustand:`);
    list(r.unsafe, (e) => `${e.rel}  (${e.grund})`);
    lines.push("");
  }
  lines.push("Optionen:");
  lines.push("  - erst 'brain pull', dann erneut pushen");
  lines.push("  - bewusst trotzdem pushen: --allow-stale");
  lines.push("");
  lines.push("(nichts wurde committet oder gepusht)");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/stale-guard-test.mjs`
Expected: `==== 13 passed, 0 failed ====` (9 Fälle, 13 Assertions — verifiziert, der Code aus Step 3 läuft wie abgedruckt)

- [ ] **Step 5: Commit**

```bash
git add lib/stale-guard.mjs tests/stale-guard-test.mjs
git commit -m "feat: pure stale-push detection logic"
```

---

### Task 2: Lokale Dateiliste mit Mirror-Semantik sammeln

**Files:**
- Modify: `lib/brain-sync.mjs` (neue Funktion direkt nach `copyTree`, ca. Zeile 215)
- Test: `tests/sandbox-test.mjs`

**Interfaces:**
- Consumes: `makeSkipper` (Zeile 177), `DEFAULT_SKIP_NAMES`
- Produces: `listMirrorable(vaultPath, shouldSkip) -> { files: string[], mtimes: Record<string, number> }` mit `/`-normalisierten Relativpfaden

Warum eine eigene Funktion und nicht `walkFiles`: `copyTree` überspringt verschachtelte Git-Repos (Verzeichnis mit `.git`). `walkFiles` tut das nicht. Ohne dieselbe Semantik weicht die geprüfte Liste von der tatsächlich gespiegelten ab.

- [ ] **Step 1: Write the failing test**

In `tests/sandbox-test.mjs` direkt vor der `==== passed ====`-Zeile am Dateiende einfügen:

```js
// === [E] the mirror never contains nested-repo files =======================
// listMirrorable (Task 2) must produce exactly the set copyTree mirrors, otherwise
// the stale guard compares against the wrong list and reports phantom deletions.
console.log("\n[E] Mirror-Semantik: nested repos");
const mirrorA = path.join(cfgA.repoPath, "vault-mirror");
ok(!fs.existsSync(path.join(mirrorA, "Nested", "inside.md")), "nested repo nicht gespiegelt");
ok(fs.existsSync(path.join(mirrorA, "Note.md")), "normale Notiz gespiegelt");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/sandbox-test.mjs`
Expected: Diese zwei Zeilen sind ein **Regressionsnetz**, kein roter Test — sie halten bestehendes Verhalten fest, damit Task 3 es nicht bricht. Sie sind sofort grün. Notiere den Zählerstand, z. B. `==== 34 passed, 0 failed ====`.

Der eigentliche rote Test für `listMirrorable` ist Task 3 Step 2: dort schlägt der Guard fehl, solange die Funktion nicht existiert.

- [ ] **Step 3: Write implementation**

In `lib/brain-sync.mjs` nach `copyTree` einfügen:

```js
// list the files that copyTree WOULD mirror, with their mtimes. same skip rules,
// same nested-repo handling - the stale guard must compare against exactly this set.
function listMirrorable(src, shouldSkip) {
  const files = [], mtimes = {};
  (function walk(dir, rel = "") {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, ent.name) : ent.name;
      if (shouldSkip(childRel)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (fs.existsSync(path.join(full, ".git"))) continue; // nested repo, never mirrored
        walk(full, childRel);
      } else if (ent.isFile()) {
        const key = childRel.split(path.sep).join("/");
        files.push(key);
        try { mtimes[key] = fs.statSync(full).mtimeMs; } catch {}
      }
    }
  })(src);
  return { files, mtimes };
}
```

- [ ] **Step 4: Run tests**

Run: `node tests/sandbox-test.mjs`
Expected: gleicher Zählerstand wie in Step 2, `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/brain-sync.mjs tests/sandbox-test.mjs
git commit -m "feat: list mirrorable vault files with copyTree semantics"
```

---

### Task 3: Guard in `cmdPush` verdrahten

**Files:**
- Modify: `lib/brain-sync.mjs` — Import oben, Einfügung nach Zeile 510 (`const manifest = loadManifest(...)`), `main()`-Usage-Text
- Test: `tests/sandbox-test.mjs`

**Interfaces:**
- Consumes: `detectStalePush`, `formatStaleReport`, `MTIME_TOLERANCE_MS` (Task 1); `listMirrorable` (Task 2)
- Produces: Exit-Code `5`, Flag `--allow-stale`

Die Prüfung muss **vor** `fs.rmSync(mirrorDir, ...)` (Zeile 526) laufen — danach ist die Remote-Dateiliste weg. Sie muss **vor** dem Secret-Scan abbrechen (Spec: Reihenfolge).

- [ ] **Step 1: Write the failing test**

In `tests/sandbox-test.mjs` vor der `==== passed ====`-Zeile einfügen:

```js
// === [F] stale push guard ==================================================
console.log("\n[F] Push-Schutz gegen veralteten Stand");
// A creates a note and pushes it. B never pulls it -> B's push would delete it.
writeText(path.join(cfgA.vaultPath, "OnlyA.md"), "created on A\n");
engine("push", HOMEA);
const rF1 = engine("push", HOMEB);
ok(rF1.status === 5, "Push von B bricht mit Exit-Code 5 ab");
ok(/ABGEBROCHEN/.test(rF1.stdout), "Abbruch wird gemeldet");
ok(/OnlyA\.md/.test(rF1.stdout), "die betroffene Datei wird genannt");

// the remote must be untouched: A pulls and still has the file
engine("pull", HOMEA);
ok(fs.existsSync(path.join(cfgA.vaultPath, "OnlyA.md")), "Remote unveraendert, Datei ueberlebt");

// dry-run reports the same and sets the same exit code
const rF2 = engine("push", HOMEB, "--dry-run");
ok(rF2.status === 5, "Dry-Run setzt denselben Exit-Code");
ok(/ABGEBROCHEN/.test(rF2.stdout), "Dry-Run meldet den Abbruch");

// --allow-stale pushes anyway
const rF3 = engine("push", HOMEB, "--allow-stale");
ok(rF3.status === 0, "--allow-stale laesst den Push durch");

// after a proper pull, B can push without the override
engine("pull", HOMEB);
writeText(path.join(cfgB.vaultPath, "AfterPull.md"), "b work\n");
const rF4 = engine("push", HOMEB);
ok(rF4.status === 0, "nach einem Pull laeuft der Push wieder normal");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/sandbox-test.mjs`
Expected: FAIL bei „Push von B bricht mit Exit-Code 5 ab" (aktuell Exit-Code 0, der Push löscht `OnlyA.md` stillschweigend).

- [ ] **Step 3: Write implementation**

Import ganz oben in `lib/brain-sync.mjs` bei den anderen Imports ergänzen:

```js
import { detectStalePush, formatStaleReport } from "./stale-guard.mjs";
```

Direkt nach `const manifest = loadManifest(cfg.repoPath);` (Zeile 510) einfügen:

```js
  // 2a. stale-state guard: refuse to mirror a vault this device never brought
  //     up to date. runs BEFORE the mirror is wiped (the remote list lives there)
  //     and before the secret scan (a stale state should not be scanned at all).
  const guardSkip = makeSkipper(cfg.excludes);
  const guardMirror = path.join(cfg.repoPath, "vault-mirror");
  const remoteFiles = fs.existsSync(guardMirror)
    ? walkFiles(guardMirror).map((f) => f.rel.split(path.sep).join("/")).filter((r) => !guardSkip(r))
    : [];
  const localList = listMirrorable(cfg.vaultPath, guardSkip);
  const stale = detectStalePush({
    remoteFiles,
    localFiles: localList.files,
    localMtimes: localList.mtimes,
    baseline: loadBaseline(),
    manifestVault: manifest.vault || {},
    indexPath: cfg.indexPath,
  });
  if (stale.blocked && !flags["allow-stale"]) {
    log(formatStaleReport(stale));
    process.exitCode = 5;
    return;
  }
  if (stale.blocked) {
    log(`\nHinweis: --allow-stale gesetzt, ${stale.deletions.length} Loeschungen und ${stale.reversions.length} Rueckdrehungen werden bewusst gepusht.`);
  }
```

Im Usage-Text von `main()` (Zeile ~860) die Push-Zeile ersetzen:

```js
      log("  push  [--dry-run] [--allow-secrets] [--allow-stale]");
```

- [ ] **Step 4: Run tests**

Run: `node tests/stale-guard-test.mjs && node tests/sandbox-test.mjs`
Expected: beide `0 failed`. Sandbox-Zähler steigt um 7.

- [ ] **Step 5: Commit**

```bash
git add lib/brain-sync.mjs tests/sandbox-test.mjs
git commit -m "feat: block push when this device has a stale vault state"
```

---

### Task 4: Toleranz in die Newer-wins-Vergleiche des Pulls

**Files:**
- Modify: `lib/brain-sync.mjs:725` (Vault), `lib/brain-sync.mjs:784` (Sessions)
- Test: `tests/sandbox-test.mjs`

**Interfaces:**
- Consumes: `MTIME_TOLERANCE_MS` (Task 1)
- Produces: nichts Neues

- [ ] **Step 1: Write the failing test**

In `tests/sandbox-test.mjs` vor der `==== passed ====`-Zeile einfügen:

```js
// === [G] pull tolerance kills the utimesSync rounding noise =================
console.log("\n[G] zweiter Pull meldet nichts als 'lokal neuer'");
engine("push", HOMEA);
engine("pull", HOMEB);            // first pull writes files + restores mtimes
const rG = engine("pull", HOMEB); // nothing changed in between
ok(!/uebersprungen \(lokal neuer\)/.test(rG.stdout),
   "unveraenderte Dateien werden beim zweiten Pull nicht als 'lokal neuer' gemeldet");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/sandbox-test.mjs`
Expected: FAIL — der zweite Pull meldet „uebersprungen (lokal neuer)".

**Hinweis:** Auf manchen Dateisystemen (ext4 mit ns-Auflösung) reproduziert sich die Rundung nicht und der Test ist schon grün. Das ist in Ordnung — er sichert das Verhalten trotzdem ab. Notiere es im Commit, statt den Test zu verbiegen.

- [ ] **Step 3: Write implementation**

Import in `lib/brain-sync.mjs` erweitern:

```js
import { detectStalePush, formatStaleReport, MTIME_TOLERANCE_MS } from "./stale-guard.mjs";
```

Zeile 725 ersetzen:

```js
    if (fs.existsSync(dp) && rec.mtime && fs.statSync(dp).mtimeMs > rec.mtime + MTIME_TOLERANCE_MS) { vskippedNewer++; continue; }
```

Zeile 784 ersetzen:

```js
          if (rec.mtime && localMtime > rec.mtime + MTIME_TOLERANCE_MS) { skippedLocalNewer++; continue; }
```

- [ ] **Step 4: Run tests**

Run: `node tests/stale-guard-test.mjs && node tests/sandbox-test.mjs`
Expected: beide `0 failed`. Insbesondere müssen `[C4]` (modify/delete conflict) und die Remap-Tests grün bleiben — dort liegen die mtimes 180 s auseinander, weit über der Toleranz.

- [ ] **Step 5: Commit**

```bash
git add lib/brain-sync.mjs tests/sandbox-test.mjs
git commit -m "fix: tolerate sub-second mtime drift in pull newer-wins checks"
```

---

### Task 5: Dokumentation

**Files:**
- Modify: `skills/brain-push/SKILL.md`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1: SKILL.md ergänzen**

In `skills/brain-push/SKILL.md` einen Abschnitt vor „Wichtige Regeln" einfügen:

```markdown
## Wenn der Push abbricht

Meldet die Engine `Push ABGEBROCHEN: dieses Geraet hat einen veralteten Stand`, hat dieses Geraet
Aenderungen vom anderen Geraet nie geholt. Wuerde man pushen, verschwaenden Dateien aus dem Remote,
die dieses Geraet nie gesehen hat, und aeltere Versionen wuerden neuere ueberschreiben.

**Richtige Reaktion:** `/brain-pull`, dann erneut pushen.

`--allow-stale` gibt es fuer den bewussten Fall (z.B. man will den Remote-Stand wirklich verwerfen).
Es ist kein Weg, die Meldung loszuwerden - es ist die Entscheidung, Daten zu verlieren.
Exit-Code des Abbruchs: 5.
```

- [ ] **Step 2: README ergänzen**

Im README bei den Push-Flags ergänzen:

```markdown
- `--allow-stale` — pusht auch dann, wenn dieses Geraet einen veralteten Stand hat und dabei
  Remote-Dateien geloescht oder zurueckgedreht wuerden. Standard ist Abbruch (Exit-Code 5).
```

- [ ] **Step 3: CHANGELOG ergänzen**

Oben im CHANGELOG einen Eintrag anlegen:

```markdown
## 0.4.0

- **Push-Schutz gegen veralteten Stand.** Ein Geraet, das den Remote-Stand nie gepullt hat, kann beim
  Push keine Dateien mehr stillschweigend loeschen oder auf aeltere Versionen zurueckdrehen. Der Push
  bricht ab (Exit-Code 5) und verweist auf `brain pull`. Bewusster Override: `--allow-stale`.
- **Fix:** Newer-wins im Pull toleriert jetzt Sub-Sekunden-Drift der mtime. Vorher meldete jeder Pull
  hunderte unveraenderte Dateien als "lokal neuer", weil `utimesSync` ueber Millisekunden schreibt,
  NTFS aber in 100ns-Ticks speichert. Das Rauschen hat echte Divergenzen verdeckt.
```

- [ ] **Step 4: Verify**

Run: `node tests/stale-guard-test.mjs && node tests/sandbox-test.mjs`
Expected: beide `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add skills/brain-push/SKILL.md README.md CHANGELOG.md
git commit -m "docs: document the push stale-state guard and --allow-stale"
```

---

### Task 6: Runtime-Cache synchronisieren und real verifizieren

**Files:**
- Modify: `~/.claude/plugins/cache/obsidian-brain-sync/obsidian-brain-sync/0.3.0/lib/` (Kopie)

Das Plugin läuft aus dem Cache, nicht aus dem Source-Repo. Ohne diesen Schritt greift der Fix im echten `/brain-push` nicht. **Neu:** Es müssen jetzt **zwei** Dateien kopiert werden, `stale-guard.mjs` ist neu dazugekommen.

- [ ] **Step 1: Dateien kopieren**

```bash
SRC="$HOME/Documents/VSCode Projects/obsidian-brain-sync"
DST="$HOME/.claude/plugins/cache/obsidian-brain-sync/obsidian-brain-sync/0.3.0"
cp "$SRC/lib/brain-sync.mjs" "$DST/lib/brain-sync.mjs"
cp "$SRC/lib/stale-guard.mjs" "$DST/lib/stale-guard.mjs"
cp "$SRC/skills/brain-push/SKILL.md" "$DST/skills/brain-push/SKILL.md"
```

- [ ] **Step 2: Byte-Gleichheit prüfen**

```bash
for f in lib/brain-sync.mjs lib/stale-guard.mjs; do
  cmp -s "$SRC/$f" "$DST/$f" && echo "OK $f" || echo "ABWEICHUNG $f"
done
```

Expected: zweimal `OK`.

- [ ] **Step 3: Echten Dry-Run fahren**

```bash
node "$DST/lib/brain-sync.mjs" push --dry-run
```

Expected: Läuft durch ohne Stale-Abbruch (dieses Gerät hat aktuell gepullt) und meldet den Vault-Mirror. Bricht es mit Exit-Code 5 ab, ist das ein echter Befund — dann die genannten Dateien prüfen, **nicht** `--allow-stale` blind setzen.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: sync runtime cache with stale-guard build"
```

---

## Self-Review

**Spec-Abdeckung:**

| Spec-Anforderung | Task |
|---|---|
| Reine Funktion `detectStalePush` | 1 |
| Regel: nie in Baseline → blockieren | 1 (Test 2) |
| Regel: Lösch-/Änderungs-Konflikt → blockieren | 1 (Test 2b) |
| Regel: Rückdrehung → blockieren | 1 (Test 3) |
| Regel: kein Manifest-Eintrag → `unsafe` | 1 (Test 5) |
| Toleranz 2000 ms an einem Ort | 1 (`MTIME_TOLERANCE_MS`) |
| Grenzfall Session-Index ausnehmen | 1 (Test 6) |
| Grenzfall keine Baseline | 1 (Test 8) |
| Grenzfall leeres Remote | 1 (Test 7) |
| Grenzfall Excludes | 2 (`listMirrorable` nutzt `makeSkipper`) |
| Aufrufstelle vor `rmSync` | 3 |
| Reihenfolge vor Secret-Scan | 3 (Einfügung bei Zeile 510, Scan bei 591) |
| Dry-Run mit gleichem Exit-Code | 3 (Test `rF2`) |
| Flag `--allow-stale`, Exit-Code 5 | 3 |
| Ausgabeformat | 1 (`formatStaleReport`, Test 9) |
| Begleitfix Pull-Toleranz | 4 |
| Integrationstest LENOVO-Szenario | 3 (`rF1`) |

Keine Lücke.

**Placeholder-Scan:** Der erste Entwurf enthielt in Task 1 Step 3 und Task 2 Step 1 je einen fehlerhaften Codeblock mit nachgeschobener Korrekturanweisung. Beides ist ersetzt: `detectStalePush` nimmt `localMtimes` jetzt direkt in der Signatur, der `arguments[0]`-Zugriff und der nicht existierende `pathToFileUrl`-Aufruf sind weg. Alle Codeblöcke sind lauffähig wie abgedruckt. Keine TBDs.

**Typkonsistenz:** `detectStalePush` nimmt durchgehend `{ remoteFiles, localFiles, localMtimes, baseline, manifestVault, indexPath }` (nach der Korrektur in Task 1). `listMirrorable` liefert `{ files, mtimes }`, in Task 3 als `localFiles: localList.files` / `localMtimes: localList.mtimes` verdrahtet. `MTIME_TOLERANCE_MS` einmal exportiert, in Task 3 und 4 importiert. Konsistent.

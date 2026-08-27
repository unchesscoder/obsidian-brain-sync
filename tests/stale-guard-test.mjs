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

// 5b. deletion WITH baseline entry but NO manifest record -> unsafe (cannot know if remote changed)
{
  const r = detectStalePush({
    remoteFiles: ["a.md"],
    localFiles: [],
    baseline: { files: { "a.md": T } },
    manifestVault: {},
    indexPath: "Claude Sessions.md",
  });
  ok(r.blocked && r.unsafe.length === 1, "Loeschung ohne Manifest-Eintrag blockiert als unsicher");
  ok(r.unsafe[0] && r.unsafe[0].grund === "kein Manifest-Eintrag", "Grund ist kein Manifest-Eintrag");
}

// 5c. local file present but no local mtime recorded (failed stat) -> unsafe
{
  const r = detectStalePush({
    remoteFiles: ["a.md"],
    localFiles: ["a.md"],
    localMtimes: {},
    baseline: { files: { "a.md": T } },
    manifestVault: { "a.md": { mtime: T + 60_000, size: 1 } },
    indexPath: "Claude Sessions.md",
  });
  ok(r.blocked && r.unsafe.length === 1, "fehlende lokale mtime blockiert als unsicher");
  ok(r.unsafe[0] && r.unsafe[0].grund === "keine lokale mtime", "Grund ist keine lokale mtime");
}

// 5d. reversion boundary: exactly at tolerance -> NOT blocked (strict comparison)
{
  const r = detectStalePush({
    remoteFiles: ["a.md"],
    localFiles: ["a.md"],
    localMtimes: { "a.md": T },
    baseline: { files: { "a.md": T } },
    manifestVault: { "a.md": { mtime: T + MTIME_TOLERANCE_MS, size: 1 } },
    indexPath: "Claude Sessions.md",
  });
  ok(!r.blocked, "Differenz von genau MTIME_TOLERANCE_MS blockiert nicht");
}

// 5e. reversion boundary: one over tolerance -> blocked
{
  const r = detectStalePush({
    remoteFiles: ["a.md"],
    localFiles: ["a.md"],
    localMtimes: { "a.md": T },
    baseline: { files: { "a.md": T } },
    manifestVault: { "a.md": { mtime: T + MTIME_TOLERANCE_MS + 1, size: 1 } },
    indexPath: "Claude Sessions.md",
  });
  ok(r.blocked && r.reversions.length === 1, "Differenz von MTIME_TOLERANCE_MS + 1 blockiert");
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

// 10. local-only file IN baseline -> remote dropped it, pushing would resurrect it -> blocked
{
  const r = detectStalePush({
    remoteFiles: [],
    localFiles: ["a.md"],
    localMtimes: { "a.md": T },
    baseline: { files: { "a.md": T } },
    manifestVault: {},
    indexPath: "Claude Sessions.md",
  });
  ok(r.blocked && r.resurrections.length === 1 && r.resurrections[0].rel === "a.md",
     "lokale Datei aus der Baseline, die remote fehlt, wird als Wiederbelebung blockiert");
}

// 11. local-only file NOT in baseline -> genuinely new note -> allowed
{
  const r = detectStalePush({
    remoteFiles: [],
    localFiles: ["new.md"],
    localMtimes: { "new.md": T },
    baseline: { files: {} },
    manifestVault: {},
    indexPath: "Claude Sessions.md",
  });
  ok(!r.blocked && r.resurrections.length === 0, "neue lokale Datei ausserhalb der Baseline wird durchgelassen");
}

// 12. baseline null (device never synced) -> every local-only file counts as new -> allowed
{
  const r = detectStalePush({
    remoteFiles: [],
    localFiles: ["a.md", "b.md"],
    localMtimes: { "a.md": T, "b.md": T },
    baseline: null,
    manifestVault: {},
    indexPath: "Claude Sessions.md",
  });
  ok(!r.blocked && r.resurrections.length === 0, "fehlende Baseline erzeugt keine Wiederbelebungs-Fehlalarme (Erstpush)");
}

// 13. session index file is local-only and in baseline, but must never be reported
{
  const r = detectStalePush({
    remoteFiles: [],
    localFiles: ["Claude Sessions.md"],
    localMtimes: { "Claude Sessions.md": T },
    baseline: { files: { "Claude Sessions.md": T } },
    manifestVault: {},
    indexPath: "Claude Sessions.md",
  });
  ok(!r.blocked && r.resurrections.length === 0, "Session-Index wird auch bei der Wiederbelebungs-Pruefung ausgenommen");
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

// non-finite mtimes must block, not slip through numeric comparisons.
// NaN passes `typeof x === "number"` and every comparison against NaN is false,
// so a naive type check would let both the deletion and the reversion path pass silently.
{
  const r = detectStalePush({
    remoteFiles: ["a.md"],
    localFiles: [],
    baseline: { files: { "a.md": T } },
    manifestVault: { "a.md": { mtime: NaN, size: 1 } },
    indexPath: "Claude Sessions.md",
  });
  ok(r.blocked && r.unsafe.length === 1, "NaN als Remote-mtime blockiert die Loeschung");
}
{
  const r = detectStalePush({
    remoteFiles: ["a.md"],
    localFiles: ["a.md"],
    localMtimes: { "a.md": T },
    baseline: { files: { "a.md": T } },
    manifestVault: { "a.md": { mtime: Infinity, size: 1 } },
    indexPath: "Claude Sessions.md",
  });
  ok(r.blocked && r.unsafe.length === 1, "Infinity als Remote-mtime blockiert");
}
{
  const r = detectStalePush({
    remoteFiles: ["a.md"],
    localFiles: ["a.md"],
    localMtimes: { "a.md": NaN },
    baseline: { files: { "a.md": T } },
    manifestVault: { "a.md": { mtime: T + 60_000, size: 1 } },
    indexPath: "Claude Sessions.md",
  });
  ok(r.blocked && r.unsafe.length === 1, "NaN als lokale mtime blockiert die Rueckdrehung");
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);

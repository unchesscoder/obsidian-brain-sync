#!/usr/bin/env node
// obsidian-brain-sync engine
// Cross-platform (Windows/macOS/Linux), pure Node, no external deps, no jq.
// Commands: init | push | pull   (optional flags: --dry-run, and init flags below)
//
// State lives in ~/.obsidian-brain-sync/ (config.json + repo/ clone + backups/).
// Data repo: <gh-user>/<repoName> (private). Tool itself is the plugin and stays separate.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".obsidian-brain-sync");
const CONFIG_PATH = path.join(STATE_DIR, "config.json");
const REPO_DIR_DEFAULT = path.join(STATE_DIR, "repo");
const BACKUP_ROOT = path.join(STATE_DIR, "backups");
// machine-local record of the vault file set this machine last synced with the
// remote (the "last common state"). enables true-mirror delete propagation on
// pull without ever touching local-only files. NOT stored in the repo.
const BASELINE_PATH = path.join(STATE_DIR, "vault-baseline.json");
const DEFAULT_REPO_NAME = "obsidian-brain";
const SESSIONS_ROOT_DEFAULT = path.join(HOME, ".claude", "projects");
const DEFAULT_INDEX_PATH = "Claude Sessions.md";

// directories/files never copied into the mirror
const DEFAULT_SKIP_NAMES = new Set([".git", ".trash", "node_modules", ".DS_Store", "Thumbs.db"]);
const DEFAULT_SKIP_REL = new Set([
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/workspace-mobile.json",
]);

const SECRET_PATTERNS = [
  { name: "OpenAI/Anthropic key", re: /\b(sk|sk-ant)-[A-Za-z0-9_-]{16,}/ },
  { name: "GitHub token", re: /\bgh[posru]_[A-Za-z0-9]{20,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------
const log = (...a) => console.log(...a);
const warn = (...a) => console.log("  ! ", ...a);
function die(msg) {
  console.error("\nFEHLER: " + msg);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return {
    code: r.status,
    signal: r.signal,
    notFound: r.error && r.error.code === "ENOENT",
    out: (r.stdout || "").trim(),
    err: (r.stderr || "").trim(),
    ok: r.status === 0,
  };
}

function requireTool(cmd, args = ["--version"], hint = "") {
  const r = run(cmd, args);
  if (r.notFound) die(`'${cmd}' wurde nicht gefunden. ${hint}`.trim());
  return r;
}

const sanitize = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function saveConfig(c) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { flags, positional };
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---------------------------------------------------------------------------
// obsidian vault detection
// ---------------------------------------------------------------------------
function obsidianConfigPath() {
  if (process.platform === "win32")
    return path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "obsidian", "obsidian.json");
  if (process.platform === "darwin")
    return path.join(HOME, "Library", "Application Support", "obsidian", "obsidian.json");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "obsidian", "obsidian.json");
}

function detectVaults() {
  const p = obsidianConfigPath();
  if (!fs.existsSync(p)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const vaults = j.vaults || {};
    return Object.values(vaults)
      .map((v) => ({ path: v.path, open: !!v.open, ts: v.ts || 0 }))
      .filter((v) => v.path && fs.existsSync(v.path))
      .sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// gh / git helpers
// ---------------------------------------------------------------------------
function ghUser() {
  const r = run("gh", ["api", "user"]);
  if (!r.ok) return null;
  try { return JSON.parse(r.out).login; } catch { return null; }
}
function repoExists(slug) {
  return run("gh", ["repo", "view", slug, "--json", "name"]).ok;
}
function git(repoDir, args, opts = {}) {
  return run("git", ["-C", repoDir, ...args], opts);
}

// fetch the remote and hard-align the working tree to the remote tip.
// the repo working tree is fully engine-managed (vault-mirror + sessions are
// regenerated from the live vault/sessions on every push), so discarding local
// working-tree state here is safe. this avoids 'git pull' aborting on dirt the
// engine itself left behind (e.g. manifest.json written but never committed by a
// previous pull) and removes the whole class of merge-conflict failures.
// returns true if it aligned to a remote branch, false if there is no upstream
// yet (a fresh repo before its first push).
function syncToRemote(repoDir) {
  const f = git(repoDir, ["fetch", "origin"]);
  if (!f.ok && !f.notFound && !git(repoDir, ["rev-parse", "HEAD"]).ok)
    die("git fetch fehlgeschlagen und kein lokaler Stand vorhanden:\n" + (f.err || f.out));
  const up = git(repoDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!up.ok) return false; // no upstream branch yet (fresh repo, first push)
  const r = git(repoDir, ["reset", "--hard", up.out]);
  if (!r.ok) die("Konnte Arbeitskopie nicht auf den Remote-Stand setzen:\n" + (r.err || r.out));
  return true;
}

// keep the data repo byte-exact across OSes: treat everything as binary so git
// never converts line endings (LF<->CRLF). without this, files on Windows show
// up as permanently "modified" - the root cause of manifest.json staying dirty.
function ensureGitattributes(repoDir) {
  const p = path.join(repoDir, ".gitattributes");
  const want = "* -text\n";
  if (!fs.existsSync(p) || fs.readFileSync(p, "utf8") !== want) fs.writeFileSync(p, want);
}

// ---------------------------------------------------------------------------
// recursive copy with skip rules (additive: never deletes at destination)
// ---------------------------------------------------------------------------
function makeSkipper(userExcludes) {
  const extraRel = new Set();
  const extraNames = new Set();
  for (const e of userExcludes || []) {
    if (!e) continue;
    const norm = e.split(/[\\/]/).join("/");
    if (norm.includes("/")) extraRel.add(norm.replace(/\/$/, ""));
    else extraNames.add(norm);
  }
  return function shouldSkip(rel) {
    const base = path.basename(rel);
    const norm = rel.split(path.sep).join("/");
    if (DEFAULT_SKIP_NAMES.has(base) || extraNames.has(base)) return true;
    if (DEFAULT_SKIP_REL.has(norm) || extraRel.has(norm)) return true;
    for (const r of extraRel) if (norm === r || norm.startsWith(r + "/")) return true;
    return false;
  };
}

// copy src tree into dst; skips nested git repos (dir containing .git) and skip rules
function copyTree(src, dst, shouldSkip, stats, rel = "") {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const ent of entries) {
    const childRel = rel ? path.join(rel, ent.name) : ent.name;
    if (shouldSkip(childRel)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      // skip nested git repos entirely (e.g. a vault sub-repo synced elsewhere)
      if (fs.existsSync(path.join(s, ".git"))) { stats.nestedSkipped.push(childRel); continue; }
      fs.mkdirSync(d, { recursive: true });
      copyTree(s, d, shouldSkip, stats, childRel);
    } else if (ent.isFile()) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      stats.files++;
    }
  }
}

function walkFiles(dir, rel = "", out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? path.join(rel, ent.name) : ent.name;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, childRel, out);
    else if (ent.isFile()) out.push({ full, rel: childRel });
  }
  return out;
}

// ---------------------------------------------------------------------------
// session parsing
// ---------------------------------------------------------------------------
function readSessionMeta(jsonlPath) {
  // returns { cwd, title, messages, ts }
  let cwd = null, title = null, messages = 0, ts = null;
  let content;
  try { content = fs.readFileSync(jsonlPath, "utf8"); } catch { return { cwd, title, messages, ts }; }
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!ts && o.timestamp) ts = o.timestamp;
    if (o.type === "user" || o.type === "assistant") messages++;
    if (!title && o.type === "user" && o.message) {
      const c = o.message.content;
      let txt = "";
      if (typeof c === "string") txt = c;
      else if (Array.isArray(c)) txt = c.map((p) => (typeof p === "string" ? p : p.text || "")).join(" ");
      txt = txt.replace(/\s+/g, " ").trim();
      if (txt && !txt.startsWith("<")) title = txt.slice(0, 100);
    }
  }
  return { cwd, title, messages, ts };
}

// rewrite the cwd field of every line that carries it; leave other lines byte-equivalent
function remapJsonlContent(content, fromCwd, toCwd) {
  if (fromCwd === toCwd) return content;
  const lines = content.split(/\r?\n/);
  return lines
    .map((line) => {
      if (!line) return line;
      let o;
      try { o = JSON.parse(line); } catch { return line; }
      if (o.cwd === fromCwd) { o.cwd = toCwd; return JSON.stringify(o); }
      return line;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// secret scan
// ---------------------------------------------------------------------------
function redact(s) {
  return s.length <= 10 ? s.slice(0, 3) + "***" : s.slice(0, 6) + "***" + s.slice(-3);
}
function secretScan(files) {
  const hits = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f.full, "utf8"); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const pat of SECRET_PATTERNS) {
        const m = lines[i].match(pat.re);
        if (m) hits.push({ file: f.rel, line: i + 1, kind: pat.name, sample: redact(m[0]) });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// session index note
// ---------------------------------------------------------------------------
function buildSessionIndex(sessionsRoot) {
  const rows = [];
  if (!fs.existsSync(sessionsRoot)) return rows;
  for (const folder of fs.readdirSync(sessionsRoot)) {
    const dir = path.join(sessionsRoot, folder);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(dir, f);
      const meta = readSessionMeta(full);
      const mt = fs.statSync(full).mtime;
      const date = (meta.ts ? new Date(meta.ts) : mt).toISOString().slice(0, 10);
      const project = meta.cwd ? path.basename(meta.cwd) : folder;
      rows.push({
        date,
        project,
        id: f.replace(/\.jsonl$/, ""),
        title: meta.title || "(kein Titel)",
        messages: meta.messages,
      });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return rows;
}

function writeSessionIndex(vaultPath, indexRelPath, rows, machine) {
  const target = path.join(vaultPath, indexRelPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const esc = (s) => String(s).replace(/\|/g, "\\|");
  let md = `---\ntitle: "Claude Sessions"\ntags: [claude, sessions, brain-sync]\ngenerated: ${new Date().toISOString()}\ngenerated_by: obsidian-brain-sync\n---\n\n`;
  md += `Auto-generierter Index aller Claude-Code-Sessions (gepusht von \`${machine}\`). Nicht von Hand editieren - wird bei jedem \`brain push\` neu geschrieben.\n\n`;
  md += `Gesamt: **${rows.length}** Sessions.\n\n`;
  md += `| Datum | Projekt | Titel | Msgs | Session-ID |\n|---|---|---|---|---|\n`;
  for (const r of rows) {
    md += `| ${r.date} | ${esc(r.project)} | ${esc(r.title)} | ${r.messages} | \`${r.id}\` |\n`;
  }
  fs.writeFileSync(target, md);
  return target;
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------
function emptyManifest() {
  return { version: 1, sessions: {}, vault: {}, history: [] };
}
function loadManifest(repoDir) {
  const p = path.join(repoDir, "manifest.json");
  if (!fs.existsSync(p)) return emptyManifest();
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return emptyManifest(); }
}
function saveManifest(repoDir, m) {
  fs.writeFileSync(path.join(repoDir, "manifest.json"), JSON.stringify(m, null, 2));
}

// ---------------------------------------------------------------------------
// vault sync baseline (machine-local) - the last common state with the remote
// ---------------------------------------------------------------------------
function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")); } catch { return null; }
}
function saveBaseline(b) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(b, null, 2));
}
function baselineFromVaultManifest(m, machine) {
  const files = {};
  for (const [rel, rec] of Object.entries((m && m.vault) || {})) files[rel] = rec.mtime;
  return { files, machine, ts: new Date().toISOString() };
}
// remove now-empty parent dirs after a delete, bottom-up, never past the vault root
function rmEmptyUp(file, stopAt) {
  let d = path.dirname(file);
  while (d.startsWith(stopAt) && d !== stopAt) {
    try { if (fs.readdirSync(d).length === 0) fs.rmdirSync(d); else break; } catch { break; }
    d = path.dirname(d);
  }
}

// ---------------------------------------------------------------------------
// repo bootstrap
// ---------------------------------------------------------------------------
function ensureRepoClone(cfg) {
  const slug = `${cfg.account}/${cfg.repoName}`;
  if (fs.existsSync(path.join(cfg.repoPath, ".git"))) {
    // healthy clone that already has commits -> use it
    if (git(cfg.repoPath, ["rev-parse", "HEAD"]).ok) return;
    // local clone is empty (was cloned while the remote had no commits yet).
    // if the remote meanwhile got content (e.g. the other machine pushed),
    // re-clone fresh so we get a proper tracking branch; otherwise keep it (first push will populate).
    git(cfg.repoPath, ["fetch", "origin"]);
    const remoteHasContent = git(cfg.repoPath, ["ls-remote", "--heads", "origin"]).out;
    if (!remoteHasContent) return;
    const url = git(cfg.repoPath, ["remote", "get-url", "origin"]).out;
    log("Lokaler Klon war leer, Remote hat jetzt Inhalt -> klone neu ...");
    fs.rmSync(cfg.repoPath, { recursive: true, force: true });
    if (url && run("git", ["clone", url, cfg.repoPath]).ok) return;
  }
  fs.mkdirSync(path.dirname(cfg.repoPath), { recursive: true });
  log(`Klone ${slug} nach ${cfg.repoPath} ...`);
  const r = run("gh", ["repo", "clone", slug, cfg.repoPath]);
  if (!r.ok) die(`Konnte Repo nicht klonen: ${r.err || r.out}`);
}

// ===========================================================================
// COMMAND: init
// ===========================================================================
function cmdInit(flags) {
  log("== obsidian-brain-sync :: init ==\n");

  // prereqs
  requireTool("git", ["--version"], "Bitte Git installieren.");
  requireTool("gh", ["--version"], "Bitte GitHub CLI (gh) installieren: https://cli.github.com");
  const auth = run("gh", ["auth", "status"]);
  if (!auth.ok) die("gh ist nicht eingeloggt. Bitte zuerst `gh auth login` ausfuehren.");

  const account = flags.account || ghUser();
  if (!account) die("Konnte GitHub-Account nicht ermitteln. `gh auth login` pruefen.");

  // --detect: only print vault candidates as JSON, write nothing
  if (flags.detect) {
    const vaults = detectVaults();
    log(JSON.stringify({ account, vaults, configExists: fs.existsSync(CONFIG_PATH) }, null, 2));
    return;
  }

  // resolve vault path
  let vaultPath = flags.vault;
  if (!vaultPath) {
    const vaults = detectVaults();
    if (vaults.length === 1) vaultPath = vaults[0].path;
    else {
      log("Mehrere oder keine Vaults automatisch erkannt. Bitte mit --vault \"<pfad>\" erneut aufrufen.\n");
      log("Erkannte Vaults:");
      vaults.forEach((v, i) => log(`  [${i}] ${v.path}`));
      die("Kein eindeutiger Vault. --vault angeben.");
    }
  }
  vaultPath = path.resolve(vaultPath);
  if (!fs.existsSync(vaultPath)) die(`Vault-Pfad existiert nicht: ${vaultPath}`);

  const repoName = flags.repo || DEFAULT_REPO_NAME;
  const repoPath = flags["repo-path"] ? path.resolve(flags["repo-path"]) : REPO_DIR_DEFAULT;
  const slug = `${account}/${repoName}`;

  // create private repo if missing
  if (!repoExists(slug)) {
    log(`Lege privates Repo ${slug} an ...`);
    const r = run("gh", ["repo", "create", slug, "--private",
      "--description", "Obsidian Brain + Claude sessions sync (private, do not make public)"]);
    if (!r.ok) die(`Repo-Erstellung fehlgeschlagen: ${r.err || r.out}`);
  } else {
    log(`Repo ${slug} existiert bereits - wird genutzt.`);
  }

  const cfg = {
    account,
    repoName,
    repoPath,
    vaultPath,
    machineName: os.hostname(),
    sessionsRoot: flags["sessions-root"] ? path.resolve(flags["sessions-root"]) : SESSIONS_ROOT_DEFAULT,
    indexPath: flags.index || DEFAULT_INDEX_PATH,
    excludes: [],
    pathMap: {},
    mirrorDelete: flags["no-mirror-delete"] ? false : true,
  };

  ensureRepoClone(cfg);

  // make sure base dirs exist in repo
  for (const d of ["vault-mirror", "sessions"]) {
    fs.mkdirSync(path.join(cfg.repoPath, d), { recursive: true });
  }
  const m = loadManifest(cfg.repoPath);
  saveManifest(cfg.repoPath, m);

  saveConfig(cfg);
  log("\nKonfiguration gespeichert:");
  log("  " + CONFIG_PATH);
  log(`  account     : ${cfg.account}`);
  log(`  data repo   : ${slug} (private)`);
  log(`  repo clone  : ${cfg.repoPath}`);
  log(`  vault       : ${cfg.vaultPath}`);
  log(`  sessions    : ${cfg.sessionsRoot}`);
  log(`  machine     : ${cfg.machineName}`);
  log("\nFertig. Jetzt `brain push` (Quellgeraet) bzw. `brain pull` (Zielgeraet) nutzen.");
}

// ===========================================================================
// COMMAND: push
// ===========================================================================
function cmdPush(flags) {
  const dry = !!flags["dry-run"];
  const cfg = loadConfig();
  if (!cfg) die("Keine config gefunden. Bitte zuerst `brain setup` (init) ausfuehren.");
  log(`== brain push ${dry ? "(DRY-RUN)" : ""} ==`);
  log(`Vault: ${cfg.vaultPath}\nRepo:  ${cfg.account}/${cfg.repoName}\n`);

  ensureRepoClone(cfg);

  // 1. align the working tree to the remote tip so we build on top of (and never
  //    clobber) another machine's newer state, and never abort on engine-left dirt
  if (!dry) {
    syncToRemote(cfg.repoPath);
    ensureGitattributes(cfg.repoPath);
  }

  const manifest = loadManifest(cfg.repoPath);

  // 2. session index into the live vault
  const rows = buildSessionIndex(cfg.sessionsRoot);
  if (!dry) {
    const idx = writeSessionIndex(cfg.vaultPath, cfg.indexPath, rows, cfg.machineName);
    log(`Session-Index geschrieben: ${idx} (${rows.length} Sessions)`);
  } else {
    log(`[dry] wuerde Session-Index schreiben: ${path.join(cfg.vaultPath, cfg.indexPath)} (${rows.length} Sessions)`);
  }

  // 3. mirror vault -> repo/vault-mirror
  const skip = makeSkipper(cfg.excludes);
  const mirrorDir = path.join(cfg.repoPath, "vault-mirror");
  const stats = { files: 0, nestedSkipped: [] };
  if (!dry) {
    fs.rmSync(mirrorDir, { recursive: true, force: true });
    fs.mkdirSync(mirrorDir, { recursive: true });
    copyTree(cfg.vaultPath, mirrorDir, skip, stats);
  } else {
    // count without writing
    const tmpSkip = skip;
    (function count(src, rel = "") {
      for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        const cr = rel ? path.join(rel, ent.name) : ent.name;
        if (tmpSkip(cr)) continue;
        const s = path.join(src, ent.name);
        if (ent.isDirectory()) { if (fs.existsSync(path.join(s, ".git"))) { stats.nestedSkipped.push(cr); continue; } count(s, cr); }
        else if (ent.isFile()) stats.files++;
      }
    })(cfg.vaultPath);
  }
  // record source mtimes of the mirrored files so pull can do newer-wins
  // (git checkout does not preserve mtime, so we track it ourselves like sessions)
  if (!dry) {
    manifest.vault = {};
    for (const f of walkFiles(mirrorDir)) {
      const relKey = f.rel.split(path.sep).join("/");
      try { const st = fs.statSync(path.join(cfg.vaultPath, f.rel)); manifest.vault[relKey] = { mtime: st.mtimeMs, size: st.size }; } catch {}
    }
  }
  log(`Vault-Mirror: ${stats.files} Dateien${dry ? " (dry)" : ""}` +
      (stats.nestedSkipped.length ? `, nested Repos uebersprungen: ${stats.nestedSkipped.join(", ")}` : ""));

  // 4. sessions -> repo/sessions (FULL tree incl. <uuid>/subagents, tool-results, memory/;
  //    newer-wins via manifest mtimes since git checkout does not preserve mtime)
  const sessRepo = path.join(cfg.repoPath, "sessions");
  let copied = 0, skippedNewerRemote = 0;
  if (fs.existsSync(cfg.sessionsRoot)) {
    for (const folder of fs.readdirSync(cfg.sessionsRoot)) {
      const srcDir = path.join(cfg.sessionsRoot, folder);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const treeFiles = walkFiles(srcDir);
      if (!treeFiles.length) continue;
      // cwd from a TOP-LEVEL .jsonl (not subagent sidecars)
      let cwd = null;
      for (const tf of treeFiles) {
        if (tf.rel.includes(path.sep) || !tf.rel.endsWith(".jsonl")) continue;
        const m = readSessionMeta(tf.full); if (m.cwd) { cwd = m.cwd; break; }
      }
      const entry = manifest.sessions[folder] || { cwd: cwd || null, sourceHome: HOME, files: {} };
      entry.cwd = cwd || entry.cwd;
      entry.sourceHome = HOME;
      for (const tf of treeFiles) {
        const relKey = tf.rel.split(path.sep).join("/");
        const localMtime = fs.statSync(tf.full).mtimeMs;
        const rec = entry.files[relKey];
        if (rec && rec.mtime > localMtime) { skippedNewerRemote++; continue; } // remote newer, keep it
        if (!dry) {
          const dp = path.join(sessRepo, folder, tf.rel);
          fs.mkdirSync(path.dirname(dp), { recursive: true });
          fs.copyFileSync(tf.full, dp);
        }
        entry.files[relKey] = { mtime: localMtime, size: fs.statSync(tf.full).size };
        copied++;
      }
      manifest.sessions[folder] = entry;
    }
  }
  log(`Sessions: ${copied} kopiert${dry ? " (dry)" : ""}` + (skippedNewerRemote ? `, ${skippedNewerRemote} uebersprungen (remote neuer)` : ""));

  // 5. secret scan over what we are about to push
  const scanFiles = [
    ...walkFiles(path.join(cfg.repoPath, "vault-mirror")),
    ...walkFiles(path.join(cfg.repoPath, "sessions")),
  ];
  const hits = dry
    ? secretScan([...walkFiles(cfg.vaultPath).filter((f) => !skip(f.rel)), ...walkFiles(cfg.sessionsRoot)])
    : secretScan(scanFiles);
  if (hits.length) {
    log(`\nSECRET-WARNUNG: ${hits.length} moegliche Geheimnisse gefunden (Repo ist privat, aber pruefe):`);
    for (const h of hits.slice(0, 25)) log(`  - ${h.kind} in ${h.file}:${h.line}  (${h.sample})`);
    if (hits.length > 25) log(`  ... und ${hits.length - 25} weitere`);
  }

  if (dry) {
    log("\n[dry-run] Nichts committed/gepusht. Entferne --dry-run fuer den echten Lauf.");
    if (hits.length) process.exitCode = 3;
    return;
  }

  // 6. commit + push
  manifest.history.unshift({ op: "push", machine: cfg.machineName, ts: new Date().toISOString() });
  manifest.history = manifest.history.slice(0, 200);
  saveManifest(cfg.repoPath, manifest);

  const status = git(cfg.repoPath, ["status", "--porcelain"]);
  if (!status.out) {
    // remote already matches our vault -> record it as the synced baseline anyway
    saveBaseline(baselineFromVaultManifest(manifest, cfg.machineName));
    log("\nNichts geaendert - Repo ist bereits aktuell."); return;
  }
  git(cfg.repoPath, ["add", "-A"]);
  const msg = `brain push from ${cfg.machineName} ${new Date().toISOString()}`;
  // fall back to a default identity if git user.name/email are not configured anywhere
  const hasIdent = git(cfg.repoPath, ["config", "user.email"]).ok;
  const identArgs = hasIdent ? [] : ["-c", "user.name=obsidian-brain-sync", "-c", "user.email=brain-sync@localhost"];
  const cm = git(cfg.repoPath, [...identArgs, "commit", "-m", msg]);
  if (!cm.ok && !/nothing to commit/i.test(cm.out + cm.err)) die("commit fehlgeschlagen:\n" + (cm.err || cm.out));
  let ph = git(cfg.repoPath, ["push"]);
  if (!ph.ok && /upstream|set-upstream|no configured push destination|does not match any/i.test(ph.err + ph.out)) {
    // first push of a fresh repo: establish the upstream branch
    ph = git(cfg.repoPath, ["push", "-u", "origin", "HEAD"]);
  }
  if (!ph.ok) die("push fehlgeschlagen:\n" + (ph.err || ph.out));

  // published successfully -> this is now our common baseline with the remote
  saveBaseline(baselineFromVaultManifest(manifest, cfg.machineName));

  log(`\nFertig. Gepusht von '${cfg.machineName}'. ${copied} Sessions, ${stats.files} Vault-Dateien.`);
  if (hits.length) log(`Hinweis: ${hits.length} moegliche Secrets im Push (siehe oben).`);
}

// ===========================================================================
// COMMAND: pull
// ===========================================================================
function cmdPull(flags) {
  const dry = !!flags["dry-run"];
  const cfg = loadConfig();
  if (!cfg) die("Keine config gefunden. Bitte zuerst `brain setup` (init) ausfuehren.");
  log(`== brain pull ${dry ? "(DRY-RUN)" : ""} ==`);
  log(`Repo:  ${cfg.account}/${cfg.repoName}\nVault: ${cfg.vaultPath}\n`);

  ensureRepoClone(cfg);

  if (!dry) syncToRemote(cfg.repoPath);

  const manifest = loadManifest(cfg.repoPath);
  const last = manifest.history && manifest.history[0];
  if (last) log(`Letzter Stand: ${last.op} von '${last.machine}' @ ${last.ts}\n`);

  // 1. backup vault before overwriting
  let backupDir = null;
  if (!dry && fs.existsSync(cfg.vaultPath)) {
    backupDir = path.join(BACKUP_ROOT, nowStamp());
    fs.mkdirSync(backupDir, { recursive: true });
    const skipB = makeSkipper(cfg.excludes);
    copyTree(cfg.vaultPath, backupDir, skipB, { files: 0, nestedSkipped: [] });
    log(`Vault-Backup: ${backupDir}`);
  }

  // 2. true-mirror sync of the vault.
  const mirrorDir = path.join(cfg.repoPath, "vault-mirror");
  const skip = makeSkipper(cfg.excludes);
  const manVault = manifest.vault || {};
  const warnings = [];

  // what the remote currently has (the authoritative published vault)
  const remoteSet = new Set();
  if (fs.existsSync(mirrorDir)) for (const f of walkFiles(mirrorDir)) { if (!skip(f.rel)) remoteSet.add(f.rel.split(path.sep).join("/")); }

  // 2a. delete-propagation: a file we previously synced (in baseline) that is now gone
  //     from the remote AND unchanged locally was deleted on the other machine -> remove
  //     it. local-only files (never in baseline) are never touched. first sync (no
  //     baseline) never deletes. the full vault backup above makes deletions recoverable.
  const mirrorDelete = cfg.mirrorDelete !== false && !flags["no-delete"];
  const baseline = loadBaseline();
  let deleted = 0, delConflict = 0;
  if (mirrorDelete && baseline && baseline.files) {
    for (const [rel, baseMtime] of Object.entries(baseline.files)) {
      if (remoteSet.has(rel)) continue;                  // still on the remote
      const dp = path.join(cfg.vaultPath, rel.split("/").join(path.sep));
      if (!fs.existsSync(dp)) continue;                  // already gone locally
      if (Math.abs(fs.statSync(dp).mtimeMs - baseMtime) > 2000) { // changed locally since last sync
        delConflict++;
        warnings.push(`lokal geaendert + remote geloescht -> behalten: ${rel}`);
        continue;
      }
      if (!dry) { try { fs.rmSync(dp); rmEmptyUp(dp, cfg.vaultPath); } catch {} }
      deleted++;
    }
  }

  // 2b. copy remote files in (newer-wins: never overwrite a locally-newer note)
  let vfiles = 0, vskippedNewer = 0;
  for (const rel of remoteSet) {
    const sp = path.join(mirrorDir, rel.split("/").join(path.sep));
    const dp = path.join(cfg.vaultPath, rel.split("/").join(path.sep));
    const rec = manVault[rel] || {};
    if (fs.existsSync(dp) && rec.mtime && fs.statSync(dp).mtimeMs > rec.mtime) { vskippedNewer++; continue; }
    if (!dry) {
      fs.mkdirSync(path.dirname(dp), { recursive: true });
      fs.copyFileSync(sp, dp);
      if (rec.mtime) { const t = new Date(rec.mtime); try { fs.utimesSync(dp, t, t); } catch {} }
    }
    vfiles++;
  }

  // 2c. record the new baseline = the remote's current set. use the remote's recorded
  //     mtime (the common version), NOT a possibly-newer local mtime, so a locally edited
  //     but unpushed file is correctly seen as "changed" on a later delete check.
  if (!dry) {
    const nb = { files: {}, machine: cfg.machineName, ts: new Date().toISOString() };
    for (const rel of remoteSet) {
      const rec = manVault[rel] || {};
      if (rec.mtime) nb.files[rel] = rec.mtime;
      else { const dp = path.join(cfg.vaultPath, rel.split("/").join(path.sep)); try { nb.files[rel] = fs.statSync(dp).mtimeMs; } catch {} }
    }
    saveBaseline(nb);
  }

  log(`Vault aktualisiert: ${vfiles} Dateien${dry ? " (dry)" : ""}` +
      (vskippedNewer ? `, ${vskippedNewer} uebersprungen (lokal neuer)` : "") +
      (deleted ? `, ${deleted} geloescht (remote entfernt)` : "") +
      (delConflict ? `, ${delConflict} Loesch-Konflikt behalten` : ""));

  // 3. sessions import with path remapping
  const sessRepo = path.join(cfg.repoPath, "sessions");
  let imported = 0, skippedLocalNewer = 0, remapped = 0;
  if (fs.existsSync(sessRepo)) {
    for (const folder of fs.readdirSync(sessRepo)) {
      const srcDir = path.join(sessRepo, folder);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const entry = manifest.sessions[folder] || {};
      const srcCwd = entry.cwd || null;

      // determine target cwd
      let targetCwd = srcCwd;
      let needRemap = false;
      if (srcCwd) {
        if (fs.existsSync(srcCwd)) {
          targetCwd = srcCwd; // symmetric: identical path exists locally
        } else {
          targetCwd = remapPath(srcCwd, entry.sourceHome || HOME, cfg.pathMap || {});
          needRemap = targetCwd !== srcCwd;
        }
      }
      const targetFolder = targetCwd ? sanitize(targetCwd) : folder;
      const destDir = path.join(cfg.sessionsRoot, targetFolder);

      for (const tf of walkFiles(srcDir)) {
        const relKey = tf.rel.split(path.sep).join("/");
        const sp = tf.full;
        const dp = path.join(destDir, tf.rel);
        const rec = (entry.files && entry.files[relKey]) || {};
        // newer-wins: don't overwrite a locally newer session file
        if (fs.existsSync(dp)) {
          const localMtime = fs.statSync(dp).mtimeMs;
          if (rec.mtime && localMtime > rec.mtime) { skippedLocalNewer++; continue; }
        }
        if (!dry) {
          fs.mkdirSync(path.dirname(dp), { recursive: true });
          if (needRemap && srcCwd && tf.rel.endsWith(".jsonl")) {
            const content = fs.readFileSync(sp, "utf8");
            fs.writeFileSync(dp, remapJsonlContent(content, srcCwd, targetCwd));
          } else {
            fs.copyFileSync(sp, dp);
          }
          // restore mtime from manifest so future newer-wins comparisons stay meaningful
          if (rec.mtime) { const t = new Date(rec.mtime); try { fs.utimesSync(dp, t, t); } catch {} }
        }
        imported++;
        if (needRemap) remapped++;
      }

      if (needRemap) warnings.push(`${folder} -> ${targetFolder} (cwd remapped: ${srcCwd} -> ${targetCwd})`);
      // best-effort verification that remapped target is discoverable
      if (needRemap && !dry && srcCwd && !fs.existsSync(targetCwd)) {
        warnings.push(`  Hinweis: Zielpfad ${targetCwd} existiert lokal (noch) nicht - 'claude --resume' findet die Session erst, wenn du dort arbeitest.`);
      }
    }
  }

  log(`Sessions importiert: ${imported}${dry ? " (dry)" : ""}` +
      (remapped ? `, davon ${remapped} remapped` : "") +
      (skippedLocalNewer ? `, ${skippedLocalNewer} uebersprungen (lokal neuer - ungepushte Arbeit!)` : ""));
  if (warnings.length) { log("\nHinweise:"); warnings.forEach((w) => log("  " + w)); }

  if (dry) { log("\n[dry-run] Nichts geschrieben."); return; }

  manifest.history.unshift({ op: "pull", machine: cfg.machineName, ts: new Date().toISOString() });
  manifest.history = manifest.history.slice(0, 200);
  saveManifest(cfg.repoPath, manifest);

  log(`\nFertig. ${imported} Sessions aktualisiert.` + (backupDir ? `\nBackup des vorherigen Vault-Stands: ${backupDir}` : ""));
  if (skippedLocalNewer) warn(`${skippedLocalNewer} Sessions waren lokal neuer und wurden NICHT ueberschrieben. Erst hier 'brain push', falls die behalten werden sollen.`);
}

// remap source absolute path to a local one (home-prefix swap + user pathMap)
function remapPath(srcPath, sourceHome, pathMap) {
  // 1. explicit user mappings (longest prefix first)
  const keys = Object.keys(pathMap || {}).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (srcPath === k || srcPath.startsWith(k)) {
      const mapped = pathMap[k] + srcPath.slice(k.length);
      return normalizeSep(mapped);
    }
  }
  // 2. home-prefix swap
  if (sourceHome && srcPath.startsWith(sourceHome)) {
    return normalizeSep(HOME + srcPath.slice(sourceHome.length));
  }
  return srcPath;
}
function normalizeSep(p) {
  // keep the separator style of the local platform for the *new* part boundary
  return p;
}

// ===========================================================================
// main
// ===========================================================================
function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { flags } = parseFlags(argv.slice(1));
  switch (cmd) {
    case "init": case "setup": return cmdInit(flags);
    case "push": return cmdPush(flags);
    case "pull": return cmdPull(flags);
    case "detect": return cmdInit({ ...flags, detect: true });
    default:
      log("obsidian-brain-sync engine");
      log("Usage: node brain-sync.mjs <init|push|pull> [--dry-run]");
      log("  init  [--vault <path>] [--repo <name>] [--detect]");
      log("  push  [--dry-run]");
      log("  pull  [--dry-run]");
      process.exit(cmd ? 1 : 0);
  }
}
main();

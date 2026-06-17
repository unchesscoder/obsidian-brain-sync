// Self-contained end-to-end test for the brain-sync engine.
// Uses tiny synthetic data + a LOCAL bare git repo as the "remote" (no GitHub, no real data).
// Simulates two machines with different HOME dirs to exercise path remapping.
//
// Run: node tests/sandbox-test.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, "..", "lib", "brain-sync.mjs");

const ROOT = path.join(os.tmpdir(), "obs-brain-test-" + Date.now());
const REMOTE = path.join(ROOT, "remote.git");
const COMMON = path.join(ROOT, "common", "ProjC"); // exists on both -> symmetric session
const HOMEA = path.join(ROOT, "homeA");
const HOMEB = path.join(ROOT, "homeB");

const sanitize = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log("  PASS " + msg); } else { fail++; console.log("  FAIL " + msg); } }
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    console.log("CMD FAILED:", cmd, args.join(" "), "\n", r.stderr || r.stdout);
  }
  return r;
}
function engine(cmd, home) {
  return sh("node", [ENGINE, cmd], { env: { ...process.env, HOME: home, USERPROFILE: home }, allowFail: true });
}
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
function writeJsonl(p, lines) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n")); }
function writeText(p, t) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); }
function read(p) { return fs.readFileSync(p, "utf8"); }

function makeConfig(home, name) {
  return {
    account: "tester", repoName: "demo",
    repoPath: path.join(home, ".obsidian-brain-sync", "repo"),
    vaultPath: path.join(home, "vault"),
    machineName: name,
    sessionsRoot: path.join(home, ".claude", "projects"),
    indexPath: "Claude Sessions.md",
    excludes: [], pathMap: {},
  };
}

// ---------------------------------------------------------------------------
console.log("Sandbox:", ROOT);
fs.mkdirSync(ROOT, { recursive: true });

// local bare "remote"
sh("git", ["init", "--bare", REMOTE]);
fs.mkdirSync(COMMON, { recursive: true });

// machine D: clone the EMPTY remote now (simulates init-before-any-push), used later
const HOMED = path.join(ROOT, "homeD");
const cfgD = makeConfig(HOMED, "machineD");
writeJson(path.join(HOMED, ".obsidian-brain-sync", "config.json"), cfgD);
sh("git", ["clone", REMOTE, cfgD.repoPath]); // empty clone, no tracking branch

// === MACHINE A: build + push ===============================================
console.log("\n[A] build + push");
const cfgA = makeConfig(HOMEA, "machineA");
writeJson(path.join(HOMEA, ".obsidian-brain-sync", "config.json"), cfgA);
sh("git", ["clone", REMOTE, cfgA.repoPath]);

// vault: a note + a nested git repo (must be skipped)
writeText(path.join(cfgA.vaultPath, "Note.md"), "# hello\n");
writeText(path.join(cfgA.vaultPath, "Nested", "inside.md"), "secret nested content\n");
sh("git", ["init", path.join(cfgA.vaultPath, "Nested")]);

// session 1: "App" - cwd under HOMEA (will NOT exist at pull -> remap), with subagent + planted secret
const cwdApp = path.join(HOMEA, "proj", "App");
const folderApp = sanitize(cwdApp);
writeJsonl(path.join(cfgA.sessionsRoot, folderApp, "s1.jsonl"), [
  { type: "user", cwd: cwdApp, sessionId: "s1", timestamp: "2026-06-16T10:00:00Z", message: { role: "user", content: "Build the App feature" } },
  { type: "assistant", cwd: cwdApp, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  { type: "user", cwd: cwdApp, message: { role: "user", content: "here is a token ghp_ABCDEFGHIJKLMNOPQRST1234 do not leak" } },
]);
writeJsonl(path.join(cfgA.sessionsRoot, folderApp, "s1", "subagents", "agent-x.jsonl"), [
  { type: "assistant", cwd: cwdApp, message: { role: "assistant", content: [{ type: "text", text: "subagent log" }] } },
]);

// session 2: "ProjC" - cwd = COMMON (exists on both -> symmetric, no remap)
const folderC = sanitize(COMMON);
writeJsonl(path.join(cfgA.sessionsRoot, folderC, "s2.jsonl"), [
  { type: "user", cwd: COMMON, sessionId: "s2", timestamp: "2026-06-16T11:00:00Z", message: { role: "user", content: "common project work" } },
]);

const rA = engine("push", HOMEA);
console.log("STDOUT:\n" + rA.stdout);
if (rA.stderr) console.log("STDERR:\n" + rA.stderr);

// assertions A: against the bare remote via a verify clone
const verify = path.join(ROOT, "verify");
sh("git", ["clone", REMOTE, verify]);
ok(fs.existsSync(path.join(verify, "vault-mirror", "Note.md")), "vault note pushed");
ok(!fs.existsSync(path.join(verify, "vault-mirror", "Nested")), "nested git repo skipped from mirror");
ok(fs.existsSync(path.join(verify, "sessions", folderApp, "s1.jsonl")), "session s1 pushed");
ok(fs.existsSync(path.join(verify, "sessions", folderApp, "s1", "subagents", "agent-x.jsonl")), "subagent sidecar pushed (full tree)");
ok(fs.existsSync(path.join(verify, "sessions", folderC, "s2.jsonl")), "symmetric session s2 pushed");
const manA = JSON.parse(read(path.join(verify, "manifest.json")));
ok(manA.sessions[folderApp] && manA.sessions[folderApp].cwd === cwdApp, "manifest records App cwd");
ok(manA.sessions[folderApp].sourceHome === HOMEA, "manifest records sourceHome = HOMEA");
ok(/SECRET-WARNUNG/.test(rA.stdout), "secret scan flagged planted token");

// === MACHINE B: pull (different HOME -> remap) =============================
console.log("\n[B] pull on a different HOME");
const cfgB = makeConfig(HOMEB, "machineB");
writeJson(path.join(HOMEB, ".obsidian-brain-sync", "config.json"), cfgB);
sh("git", ["clone", REMOTE, cfgB.repoPath]); // second machine clones populated repo
writeText(path.join(cfgB.vaultPath, "old.md"), "pre-existing local note\n"); // force a backup

const rB = engine("pull", HOMEB);
console.log(rB.stdout.split("\n").filter(Boolean).slice(-8).join("\n"));

// vault restored
ok(fs.existsSync(path.join(cfgB.vaultPath, "Note.md")), "vault note restored on B");
ok(fs.existsSync(path.join(cfgB.vaultPath, "old.md")), "pre-existing local note preserved (pull never deletes)");
// backup made
const backups = path.join(HOMEB, ".obsidian-brain-sync", "backups");
ok(fs.existsSync(backups) && fs.readdirSync(backups).length === 1, "vault backup created before overwrite");

// App session remapped: HOMEA/proj/App -> HOMEB/proj/App
const cwdAppB = path.join(HOMEB, "proj", "App");
const folderAppB = sanitize(cwdAppB);
const appOnB = path.join(cfgB.sessionsRoot, folderAppB, "s1.jsonl");
ok(fs.existsSync(appOnB), "App session imported into REMAPPED folder on B");
ok(fs.existsSync(path.join(cfgB.sessionsRoot, folderAppB, "s1", "subagents", "agent-x.jsonl")), "subagent sidecar imported into remapped folder");
const appContent = appOnB && fs.existsSync(appOnB) ? read(appOnB) : "";
ok(appContent.includes(JSON.stringify(cwdAppB)) && !appContent.includes(JSON.stringify(cwdApp)), "cwd field inside jsonl rewritten to local path");

// ProjC symmetric: cwd COMMON exists on B -> NOT remapped
const cOnB = path.join(cfgB.sessionsRoot, folderC, "s2.jsonl");
ok(fs.existsSync(cOnB), "symmetric session imported unchanged folder");
ok(fs.existsSync(cOnB) && read(cOnB).includes(JSON.stringify(COMMON)), "symmetric session cwd left unchanged");

// === newer-wins on pull ====================================================
console.log("\n[C] newer-wins");
// make local ProjC newer than manifest, pull again -> must NOT be overwritten
writeText(cOnB, read(cOnB) + "\nLOCAL-NEWER-MARKER");
const future = new Date(Date.now() + 60000);
fs.utimesSync(cOnB, future, future);
const rC = engine("pull", HOMEB);
ok(/uebersprungen \(lokal neuer/.test(rC.stdout) || read(cOnB).includes("LOCAL-NEWER-MARKER"), "locally-newer session not overwritten");

// === newer-wins on pull for VAULT notes ====================================
console.log("\n[C2] vault newer-wins");
// edit Note.md locally and make it newer than the manifest, pull -> must be kept
const noteB = path.join(cfgB.vaultPath, "Note.md");
writeText(noteB, "LOCAL VAULT EDIT WINS\n");
const fut2 = new Date(Date.now() + 120000);
fs.utimesSync(noteB, fut2, fut2);
const rC2 = engine("pull", HOMEB);
ok(read(noteB).includes("LOCAL VAULT EDIT WINS"), "locally-newer vault note not overwritten");
ok(/uebersprungen \(lokal neuer/.test(rC2.stdout), "pull reports skipped locally-newer vault file");

// === delete-propagation (true mirror) ======================================
console.log("\n[C3] delete-propagation");
// a brand-new local-only note on B that the remote has never seen -> must survive
writeText(path.join(cfgB.vaultPath, "LocalOnlyB.md"), "only on B\n");
// A adds a shared note + pushes, B pulls so both have it (B's baseline records it)
writeText(path.join(cfgA.vaultPath, "ToDelete.md"), "temp\n");
engine("push", HOMEA);
engine("pull", HOMEB);
ok(fs.existsSync(path.join(cfgB.vaultPath, "ToDelete.md")), "shared note present on B before delete");
// A deletes it + pushes, B pulls -> must be removed on B too
fs.rmSync(path.join(cfgA.vaultPath, "ToDelete.md"));
engine("push", HOMEA);
const rC3 = engine("pull", HOMEB);
ok(!fs.existsSync(path.join(cfgB.vaultPath, "ToDelete.md")), "remotely-deleted note removed on B (mirror delete)");
ok(/geloescht/.test(rC3.stdout), "pull reports the deletion");
ok(fs.existsSync(path.join(cfgB.vaultPath, "LocalOnlyB.md")), "local-only note never touched by mirror delete");
ok(fs.existsSync(path.join(cfgB.vaultPath, "old.md")), "pre-existing local-only note still safe");

// === modify/delete conflict -> keep local ==================================
console.log("\n[C4] modify/delete conflict keeps local edit");
writeText(path.join(cfgA.vaultPath, "Keep.md"), "v1\n");
engine("push", HOMEA);
engine("pull", HOMEB); // B now has Keep.md, baseline records it
// B edits Keep.md locally (newer); A deletes Keep.md and pushes
writeText(path.join(cfgB.vaultPath, "Keep.md"), "B local edit\n");
const futK = new Date(Date.now() + 180000); fs.utimesSync(path.join(cfgB.vaultPath, "Keep.md"), futK, futK);
fs.rmSync(path.join(cfgA.vaultPath, "Keep.md"));
engine("push", HOMEA);
const rC4 = engine("pull", HOMEB);
ok(fs.existsSync(path.join(cfgB.vaultPath, "Keep.md")) && read(path.join(cfgB.vaultPath, "Keep.md")).includes("B local edit"),
   "modify/delete conflict keeps the local edit");
ok(/Loesch-Konflikt/.test(rC4.stdout), "pull reports the modify/delete conflict");

// === pull on an EMPTY clone created before any push (the real first-use case) =====
console.log("\n[D] pull on an empty clone (was cloned while remote was empty)");
const rD = engine("pull", HOMED);
if (rD.stderr) console.log("STDERR:\n" + rD.stderr);
ok(/klone neu/i.test(rD.stdout), "empty clone detected and re-cloned");
ok(fs.existsSync(path.join(cfgD.vaultPath, "Note.md")), "content pulled successfully onto machine D");

// ---------------------------------------------------------------------------
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (!fail) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} }
else console.log("Sandbox belassen zum Inspizieren:", ROOT);
process.exit(fail ? 1 : 0);

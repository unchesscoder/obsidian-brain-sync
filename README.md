# obsidian-brain-sync

**Keep your Obsidian vault *and* your Claude Code sessions in sync across every machine you work on — through your own private GitHub repo, for free.**

A Claude Code plugin. Push on your laptop, pull on your desktop, and pick up exactly where you left off — including resuming the *same* Claude conversation with `claude --resume`.

---

## Why you might want this

If you use Claude Code on more than one machine, you have probably hit this wall:

- **Your code syncs through Git. Your thinking doesn't.** Notes, decisions, research, and your "second brain" live in Obsidian — and there's no built-in way to move them between machines without paying.
- **Your Claude sessions are trapped on one device.** Claude Code stores every conversation as a local `.jsonl` file under `~/.claude/projects/`. Switch machines and that context is simply gone — you start cold, re-explaining what you already worked through yesterday.
- **The usual workarounds are bad.** Emailing files to yourself, copy-pasting transcripts, or paying a monthly subscription just to move plain text around.

`obsidian-brain-sync` closes both gaps with one mechanism you already trust: a **private GitHub repo**. It mirrors your vault and your full session history into that repo, and restores them on the other side — so your knowledge *and* your AI context travel together.

The headline feature: **session portability**. After a pull, `claude --resume` on the second machine lists the conversations you had on the first one and lets you continue them as if you never switched seats.

## What it does

| Skill | Purpose |
|-------|---------|
| `/brain-setup` | One-time per machine. Detects your Obsidian vault, reads your GitHub account, and creates the private data repo. |
| `/brain-push`  | Mirror your vault and **all** Claude sessions into the data repo and push. Run it before you switch devices. |
| `/brain-pull`  | Pull the latest state and restore vault + sessions locally — with path remapping so resume works even across different usernames or operating systems. |

Along the way it also writes a searchable **session index** note into your vault (date, project, title, message count for every session), so your Claude history becomes part of your brain, not just a pile of opaque files.

## How it works

Two clearly separated repositories:

1. **The tool** — this plugin (`obsidian-brain-sync`). Installed once per machine, shared by everyone.
2. **Your data** — `<you>/obsidian-brain`, a **private** repo created automatically by `/brain-setup`. This is yours alone.

Everything local lives under `~/.obsidian-brain-sync/`:

```
~/.obsidian-brain-sync/
  config.json          # account, repo, vault path, machine name, excludes, pathMap, mirrorDelete
  repo/                # local clone of your private data repo (engine-managed, disposable)
  vault-baseline.json  # the vault file set this machine last synced (for safe delete-propagation)
  backups/<ts>/        # full vault snapshot taken automatically before every pull
```

…and the data repo holds:

```
<you>/obsidian-brain
  vault-mirror/    # a full snapshot of the last pusher's vault
  sessions/        # the complete ~/.claude/projects tree (sessions + subagents + tool results)
  manifest.json    # per-file modification times, session cwd/home, push/pull history
```

A single dependency-free Node engine (`lib/brain-sync.mjs`, no npm packages, no `jq`) does all the work.

### The sync model

Both push and pull start by **hard-aligning the local clone to the remote tip** (`git fetch` + `git reset --hard`). The clone is purely a staging area the engine regenerates from scratch, so this can never lose real data — and it means there are **no Git merge conflicts to resolve** and no half-committed state to get stuck on. (Your actual vault lives in a different directory and is never touched by this reset.)

**Push** then snapshots your vault into `vault-mirror/`, copies your full session tree into `sessions/`, records every file's modification time in `manifest.json`, runs the secret scan, commits, and pushes. It also saves that snapshot as this machine's *baseline* — the state now known to be common with the remote.

**Pull** reconciles three things for every file — your **local** vault, the **remote** mirror, and your **baseline** — with these rules:

| Situation | Result |
|-----------|--------|
| File only on the remote (you never had it) | **added** locally |
| File on both sides, the remote copy is newer | **overwritten** locally |
| File on both sides, your *local* copy is newer | **kept** (newer-wins), reported |
| File gone from the remote, was in your baseline, unchanged locally | **deleted** locally — the delete propagated |
| File gone from the remote, but you edited it locally | **kept**, reported as a conflict |
| File only local, never in the baseline | **untouched** — it's your new work, pending its own push |

Sessions follow the same newer-wins idea and additionally **remap their paths** so `claude --resume` finds them on the new machine even under a different username or OS.

## Requirements

- [Git](https://git-scm.com/) and [Node.js](https://nodejs.org/)
- [GitHub CLI](https://cli.github.com/), authenticated: `gh auth login`
- [Claude Code](https://claude.com/claude-code)

## Install

```
/plugin marketplace add unchesscoder/obsidian-brain-sync
/plugin install obsidian-brain-sync
```

Then, on **each** machine:

```
/brain-setup
```

## Two machines

The model is simple: **one GitHub account, one private data repo, both machines talk to it.**

1. **Install + set up on machine A** (e.g. your laptop): install the plugin (above), then run `/brain-setup`. The first machine to run setup creates the private data repo `<you>/obsidian-brain`.
2. **Install + set up on machine B** (e.g. your desktop): same steps. Because the data repo already exists, setup simply reuses it. Make sure `gh` is logged into the **same** GitHub account on both machines.

That is the one-time part. From then on it is just push and pull.

### Your first sync

Nothing is in the repo until a machine pushes, so the very first time the order matters:

1. On the machine that holds the work you want to move (say machine A): **`/brain-push`** — uploads its vault and all sessions.
2. On the other machine (machine B): **`/brain-pull`** — brings everything down. `claude --resume` will now list the sessions from machine A.

After that, sync in whichever direction you switch.

## Daily workflow

- **Laptop, end of day:** `/brain-push`
- **Desktop, next morning:** `/brain-pull`, then keep working. `claude --resume` finds yesterday's sessions.

> **Golden rule: pull before you work, push when you're done.**

## Your data stays yours

There is no middleman. This plugin runs **entirely on your machine** and syncs **directly to a private GitHub repository in your own account**. There is no server, no telemetry, no third-party endpoint, and no shared storage. The plugin author never receives, sees, or has access to your vault or your sessions — the only external service involved is GitHub, under your own account and your own terms.

## Safety & privacy by design

- The data repo is created **private** and must stay private — session logs can contain pasted secrets or personal data.
- Every push runs a **secret scan** (API keys, GitHub/Slack tokens, private-key blocks, …) and **blocks the push** if it finds anything — nothing is committed or uploaded. Clean the file and retry, allowlist a known false positive (e.g. an example token) in `secretAllowlist`, or push on purpose with `--allow-secrets`.
- **True mirror with safe deletes.** A note deleted on one machine is removed on the other on the next pull — but *only* if that file was part of the last synced state and you have not changed it locally. Files you created locally that the remote never had are **never** touched, and the very first sync (no baseline yet) never deletes. Can be turned off per pull with `--no-delete` or per machine via `mirrorDelete: false` in the config.
- Every pull takes a **full vault backup first**, so any overwrite *or deletion* is always recoverable.
- A **newer-wins** rule per file means the sync never silently clobbers work that is newer locally — it skips and warns instead. A delete-vs-local-edit clash is resolved by **keeping your local edit** and warning.

## Design notes & honest limitations

- **Sequential use is assumed** — one machine at a time. Before each push or pull the engine **hard-aligns its internal working copy to the remote tip** and rebuilds from there, then reconciles per file with newer-wins — so there are no Git merge conflicts to resolve and no stale, half-committed state to get stuck on. Your real vault lives in a separate directory and is never touched by this reset.
- **Path remapping** lets `claude --resume` work even when your machines use different usernames, paths, or operating systems. The manifest stores each session's original working directory and home dir; on import the engine swaps the home prefix (plus any explicit `config.pathMap` entries), recomputes Claude Code's session-folder name, and rewrites the stored `cwd`. This relies on Claude Code's folder-naming scheme — verified as `cwd.replace(/[^a-zA-Z0-9]/g, "-")` — so it is **exact for symmetric setups** (same path on both machines) and **best-effort** across operating systems.
- **Nested Git repos** inside your vault (a sub-folder with its own `.git`) are skipped automatically — they already sync through their own remote, and are therefore also exempt from delete-propagation.
- **Deletes propagate via a machine-local baseline** (`~/.obsidian-brain-sync/vault-baseline.json`) that records the last synced file set. This is a three-way reconciliation (baseline vs remote vs local), not a content-level merge: if the *same* file is edited on both machines without syncing in between, newer-wins keeps the newer version and the older edit is lost. For one-machine-at-a-time use (pull before you start, push when you stop) this never triggers.

## Configuration

`~/.obsidian-brain-sync/config.json` is written by `/brain-setup`; you can edit it by hand:

| Field | Meaning |
|-------|---------|
| `vaultPath` | Absolute path to the Obsidian vault that gets mirrored. |
| `sessionsRoot` | Where Claude Code stores sessions (default `~/.claude/projects`). |
| `indexPath` | Where the generated session-index note is written inside the vault. |
| `excludes` | Extra file/folder names or relative paths to skip when mirroring. |
| `pathMap` | Explicit `source → local` path mappings for session remapping. |
| `mirrorDelete` | `true` (default) propagates deletes; set `false` to make pull purely additive. |
| `secretAllowlist` | Exact matched-token strings to treat as known false positives (e.g. example/placeholder tokens) so they don't block a push. |

Per-run overrides on the engine: `--no-delete` disables delete-propagation for a single pull, `--allow-secrets` pushes even though the secret scan found something, and `--dry-run` previews **any** command (push, pull) without writing or pushing anything.

```
node lib/brain-sync.mjs pull --dry-run        # see exactly what a pull would add / overwrite / delete
node lib/brain-sync.mjs pull --no-delete      # pull this once without removing anything
node lib/brain-sync.mjs push --dry-run        # see what would be pushed + any secret findings
node lib/brain-sync.mjs push --allow-secrets  # push despite a secret finding (deliberate)
```

## Troubleshooting

- **"It deleted a note I wanted."** Restore it from the newest `~/.obsidian-brain-sync/backups/<timestamp>/` (a backup is taken before every pull). To stop delete-propagation, set `mirrorDelete: false` in `config.json` or pull with `--no-delete`.
- **A note keeps coming back after I delete it.** You deleted it on one machine but never pushed from there, or the other machine still runs an older version. Deletes only propagate when **both** machines run ≥ v0.2.0 and you push from the machine where you deleted.
- **`claude --resume` doesn't list a session.** The pull printed a remap hint: the project's path doesn't exist on this machine yet. Open or create that folder (or add a `pathMap` entry) and resume will find it.
- **Push aborted: secret found.** A credential was detected in a file about to be pushed, so the push stopped and uploaded nothing. Review the match. If it's real, clean the file (and rotate the credential) and push again. If it's a false positive (e.g. an example token like `ghp_ABCDEFGHIJKLMNOPQRST1234`), add the exact string to `secretAllowlist` in the config. To push anyway on purpose, use `--allow-secrets`.
- **Reset the delete-tracking.** Delete `~/.obsidian-brain-sync/vault-baseline.json`; the next sync rebuilds it and is guaranteed not to delete anything on that run.
- **A pull or push seems to ignore the other machine.** Make sure `gh` is logged into the **same** GitHub account on both, and that the other machine actually finished its `/brain-push`.

## Testing

A self-contained end-to-end test runs the full push → pull → remap → delete-propagation cycle against a local Git remote with synthetic data (no network, no real data, no GitHub):

```
node tests/sandbox-test.mjs
```

It covers vault mirroring, nested-repo skipping, session import with path remapping and subagent sidecars, newer-wins for both sessions and vault notes, delete-propagation, the modify-vs-delete conflict, and first-use on an empty clone.

## Disclaimer

This is an independent, community-built tool. Please read this before using it.

- **No warranty.** The software is provided "as is", without warranty of any kind, to the fullest extent permitted by law (see [LICENSE](LICENSE)). You use it at your own risk. While it takes a full vault backup before every pull and never overwrites newer local files, the authors accept no liability for any data loss, corruption, or other damage.

- **You are responsible for your own data and compliance.** You decide what gets synced and where. If your vault or sessions contain personal data of third parties (for example client information), **you** are the data controller and are responsible for ensuring an appropriate legal basis and storage location — including, where applicable, GDPR obligations and a data processing agreement with your Git host. Keep the data repository private. The built-in secret scan detects credentials, not personal data.

- **It only touches your own files.** The plugin reads and copies the local files that Obsidian and Claude Code already write on your own machine (your vault, and your session logs under `~/.claude/`). It does **not** decompile, reverse-engineer, modify, or redistribute Obsidian, Claude Code, or any other software. It relies on an undocumented local file layout that may change at any time, which could break the tool without notice.

- **Not affiliated.** This project is not affiliated with, endorsed by, or sponsored by Obsidian (Obsidian.md) or Anthropic. "Obsidian" and "Claude" are trademarks of their respective owners and are used here only descriptively, to indicate compatibility.

## License

MIT — see [LICENSE](LICENSE).

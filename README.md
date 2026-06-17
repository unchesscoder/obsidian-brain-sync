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

1. **The tool** — this plugin. Installed once per machine, shared by everyone.
2. **Your data** — `<you>/obsidian-brain`, a **private** repo created automatically by `/brain-setup`. This is yours alone.

A single dependency-free Node engine (`lib/brain-sync.mjs`) does the work:

```
~/.obsidian-brain-sync/
  config.json        # account, repo, vault path, machine name, excludes, pathMap
  repo/              # local clone of your private data repo
  backups/<ts>/      # full vault snapshot taken automatically before every pull
```

On **push** it mirrors the vault into `vault-mirror/`, copies the complete session trees
(`~/.claude/projects/`, including subagent logs and tool results) into `sessions/`, records
everything in `manifest.json`, then commits and pushes. **Pull** does the reverse, safely.

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
- Every push runs a **secret scan** (API keys, GitHub/Slack tokens, private-key blocks, …) and warns you about matches *before* anything leaves your machine.
- **Pull never deletes** local files — it only overwrites and adds. A note deleted on machine A will not vanish on machine B. (Deliberate, to prevent data loss.)
- Every pull takes a **full vault backup first**, so an unexpected overwrite is always recoverable.
- A **newer-wins** rule per file means the sync never silently clobbers work that is newer locally — it skips and warns instead.

## Design notes & honest limitations

- **Sequential use is assumed** — one machine at a time. The engine pulls before it pushes and uses newer-wins per file, so it won't blindly overwrite. A real merge conflict makes it **stop and report** rather than guess.
- **Path remapping** lets `claude --resume` work even when your machines use different usernames, paths, or operating systems. The manifest stores each session's original working directory and home dir; on import the engine swaps the home prefix (plus any explicit `config.pathMap` entries), recomputes Claude Code's session-folder name, and rewrites the stored `cwd`. This relies on Claude Code's folder-naming scheme — verified as `cwd.replace(/[^a-zA-Z0-9]/g, "-")` — so it is **exact for symmetric setups** (same path on both machines) and **best-effort** across operating systems.
- **Nested Git repos** inside your vault (a sub-folder with its own `.git`) are skipped automatically — they already sync through their own remote.
- Deletions do not propagate (see above). A future `--mirror-delete` mode could opt into this.

## Testing

A self-contained end-to-end test runs the full push → pull → remap cycle against a local Git remote with synthetic data (no network, no real data):

```
node tests/sandbox-test.mjs
```

## Disclaimer

This is an independent, community-built tool. Please read this before using it.

- **No warranty.** The software is provided "as is", without warranty of any kind, to the fullest extent permitted by law (see [LICENSE](LICENSE)). You use it at your own risk. While it takes a full vault backup before every pull and never overwrites newer local files, the authors accept no liability for any data loss, corruption, or other damage.

- **You are responsible for your own data and compliance.** You decide what gets synced and where. If your vault or sessions contain personal data of third parties (for example client information), **you** are the data controller and are responsible for ensuring an appropriate legal basis and storage location — including, where applicable, GDPR obligations and a data processing agreement with your Git host. Keep the data repository private. The built-in secret scan detects credentials, not personal data.

- **It only touches your own files.** The plugin reads and copies the local files that Obsidian and Claude Code already write on your own machine (your vault, and your session logs under `~/.claude/`). It does **not** decompile, reverse-engineer, modify, or redistribute Obsidian, Claude Code, or any other software. It relies on an undocumented local file layout that may change at any time, which could break the tool without notice.

- **Not affiliated.** This project is not affiliated with, endorsed by, or sponsored by Obsidian (Obsidian.md) or Anthropic. "Obsidian" and "Claude" are trademarks of their respective owners and are used here only descriptively, to indicate compatibility.

## License

MIT — see [LICENSE](LICENSE).

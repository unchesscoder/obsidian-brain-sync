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

## Daily workflow

- **Laptop, end of day:** `/brain-push`
- **Desktop, next morning:** `/brain-pull`, then keep working. `claude --resume` finds yesterday's sessions.

> **Golden rule: pull before you work, push when you're done.**

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

## License

MIT

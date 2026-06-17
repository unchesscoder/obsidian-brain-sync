# obsidian-brain-sync

Sync your **Obsidian vault** *and* your **Claude Code sessions** across machines through a **private
GitHub repo**. A free alternative to Obsidian Sync, with one extra superpower: your Claude
conversations travel with you, so you can `claude --resume` the exact session on the other device.

Built as a Claude Code plugin. Three skills:

| Skill | What it does |
|-------|--------------|
| `/brain-setup` | One-time per machine: detects your vault, reads your GitHub account, creates the private data repo. |
| `/brain-push`  | Mirror vault + all Claude sessions into the data repo and push. Run before switching devices. |
| `/brain-pull`  | Pull the latest state, restore vault + sessions locally (with path remapping). Run before you start working. |

## How it works

Two clearly separated repos:

1. **The tool** — this plugin (`obsidian-brain-sync`). Shared, installed once per machine.
2. **Your data** — `<you>/obsidian-brain`, a **private** repo created automatically by `/brain-setup`.

The engine (`lib/brain-sync.mjs`, pure Node, no dependencies) mirrors your vault into
`vault-mirror/` and your sessions (`~/.claude/projects/*.jsonl`) into `sessions/`, tracks everything
in `manifest.json`, commits and pushes. Pull does the reverse.

```
~/.obsidian-brain-sync/
  config.json        # account, repo, vault path, machine name, excludes, pathMap
  repo/              # local clone of your private data repo
  backups/<ts>/      # full vault snapshot taken before every pull
```

## Requirements

- [Git](https://git-scm.com/) and [Node.js](https://nodejs.org/)
- [GitHub CLI](https://cli.github.com/) logged in: `gh auth login`
- Claude Code (this is a plugin)

## Install

```
/plugin marketplace add unchesscoder/obsidian-brain-sync
/plugin install obsidian-brain-sync
```

Then on **each** machine:

```
/brain-setup
```

## Daily use

- **Laptop, end of day:** `/brain-push`
- **Desktop, next morning:** `/brain-pull`, then keep working — `claude --resume` finds your sessions.

Golden rule: **pull before you work, push when you're done.**

## Design notes & honest limitations

- **Sequential use assumed** — one machine at a time. The engine pulls before pushing and uses a
  *newer-wins* rule per file, so it won't blindly clobber. A real merge conflict makes it **stop**
  and report rather than guess.
- **Pull never deletes** local files (it overwrites/adds only). Deleting a note on machine A will not
  remove it on machine B. This is deliberate, to avoid data loss. (A `--mirror-delete` mode could be
  added later.)
- **Path remapping** lets `claude --resume` work even when your two machines use different
  usernames/paths/OS: the manifest stores each session's original `cwd` + home dir, and on import the
  engine swaps the home prefix (plus any explicit `config.pathMap`), recomputes Claude Code's session
  folder name, and rewrites the `cwd` field. This relies on Claude Code's (undocumented) folder-naming
  scheme — verified as `cwd.replace(/[^a-zA-Z0-9]/g, "-")` — so it is **best-effort** for cross-OS
  setups and **exact** for symmetric ones (same path on both machines).
- **Nested git repos** inside the vault (a sub-folder with its own `.git`) are skipped automatically —
  they sync through their own remote.

## Security / privacy

- The data repo is created **private** and must stay private — session logs can contain pasted secrets
  or personal data.
- Every push runs a **secret scan** (API keys, GitHub/Slack tokens, private-key blocks, …) and warns
  you about matches before they leave your machine.

## License

MIT

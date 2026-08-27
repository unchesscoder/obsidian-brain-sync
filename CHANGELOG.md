# Changelog

All notable changes to **obsidian-brain-sync** are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.4.0] — 2026-08-27

### Added
- **The push now refuses to destroy the remote from a stale machine.** The push is a mirror, so a
  machine that had not pulled in a while would silently delete files it never knew about, overwrite
  newer notes with older copies, and resurrect files another machine had deleted. Before mirroring,
  the push compares the remote against the last state this machine actually synced and **aborts**
  (exit 5) if any of those three would happen, naming every affected file. Nothing is committed or
  uploaded. The fix is a `pull`; `--allow-stale` overrides deliberately.
  A deletion is only let through when the remote still holds exactly the version this machine last
  saw — if it moved on since, the deletion would discard someone else's work and is blocked too.
  Any state the guard cannot judge (missing manifest entry, unreadable mtime) blocks as well:
  in doubt, block.

### Fixed
- **Phantom "lokal neuer" reports on pull.** `utimesSync` writes an mtime through a JS `Date`
  (milliseconds) while NTFS stores 100ns ticks, so every file a pull wrote read back marginally
  "newer" on the next pull — hundreds of false reports per run. Both newer-wins comparisons now use
  the same 2s tolerance the delete check already used. This mattered more than it looks: that noise
  is what hid a real two-month data divergence until files went missing.
- **Leftover mirror files after an aborted push.** `git reset --hard` does not remove untracked
  files, so a push aborted by the secret scan left stale `vault-mirror` content behind that made the
  next run misjudge what the remote actually contained. The working copy is now cleaned as well.
- **`--dry-run` on push could reach a different verdict than the real run.** It skipped the remote
  sync, so it judged staleness against a possibly days-old local clone. It now refreshes first — a
  preview that can disagree with the run it previews is worse than no preview.

## [0.3.0] — 2026-06-17

### Changed
- **The secret scan now blocks the push by default.** Previously it only warned and pushed anyway.
  If any potential secret is detected, the push aborts (exit 4) and **nothing is committed or
  uploaded**. This makes accidental credential leaks structurally hard instead of merely flagged.

### Added
- `secretAllowlist` config field: exact matched-token strings to treat as known false positives
  (e.g. placeholder/example tokens) so they don't block a push.
- `--allow-secrets` flag to push deliberately despite a finding.
- `--dry-run push` now notes whether the findings would block the real push.

## [0.2.0] — 2026-06-17

### Added
- **True-mirror sync with safe delete-propagation.** A note deleted (or renamed) on one
  machine is now removed on the other on the next pull. It is gated by a three-way
  reconciliation against a machine-local baseline (`~/.obsidian-brain-sync/vault-baseline.json`):
  a file is deleted locally **only** if it was part of the last synced state, is now gone from
  the remote, and has not been changed locally.
  - Files you created locally that the remote never had are **never** touched.
  - The first sync (no baseline yet) never deletes.
  - A delete-vs-local-edit clash keeps your local edit and reports a conflict.
  - Every pull still takes a full vault backup first, so any deletion is recoverable.
  - Configurable via `mirrorDelete` in `config.json` (default `true`) and the `--no-delete` flag.
- Empty folders left behind by a propagated deletion are cleaned up.
- README: deeper "How it works" with the full reconciliation table, plus Configuration and
  Troubleshooting sections.

### Changed
- `newer-wins` now also applies to **vault notes** (previously sessions only); the engine tracks
  per-file modification times for the vault in `manifest.json`.

## [0.1.1] — 2026-06-17

### Fixed
- **Pull could silently use a stale mirror.** Replaced the internal `git pull` (in both push and
  pull) with a robust `fetch` + `reset --hard` to the remote tip. The repo clone is engine-managed
  and regenerated, so this is safe and eliminates two failure modes: a `manifest.json` left dirty by
  a previous pull blocking the next one, and any non-conflict Git error being swallowed.
- Real (non-conflict) Git failures now surface instead of being ignored.

### Added
- `.gitattributes` (`* -text`) in the data repo to disable line-ending conversion, keeping the
  mirror byte-exact across operating systems and preventing files from appearing spuriously modified
  on Windows.

## [0.1.0]

### Added
- Initial release: `/brain-setup`, `/brain-push`, `/brain-pull`.
- Vault mirroring and full Claude Code session sync (sessions, subagents, tool results) through a
  private GitHub repo.
- Cross-OS path remapping so `claude --resume` works across machines.
- Automatic vault backup before every pull, and a secret scan before every push.
- Generated session-index note in the vault.

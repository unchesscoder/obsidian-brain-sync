---
name: brain-setup
description: "Einmalige Erstkonfiguration fuer obsidian-brain-sync auf diesem Geraet: erkennt den Obsidian-Vault, ermittelt den GitHub-Account und legt das private Daten-Repo an. Muss einmal pro Geraet laufen, bevor brain-push/brain-pull genutzt werden. Trigger DE: 'brain setup', 'brain einrichten', 'brain sync einrichten', 'brain konfigurieren', 'sync einrichten'. Trigger EN: 'brain setup', 'setup brain sync', 'configure brain sync', 'init brain sync'."
---

# Brain Setup

Einmalige Einrichtung von **obsidian-brain-sync** auf diesem Geraet. Danach synchronisieren
`/brain-push` und `/brain-pull` Vault + Claude-Sessions ueber ein **privates** GitHub-Repo.

Voraussetzungen (die Engine prueft das selbst und meldet klar, wenn etwas fehlt): `git`, `node`,
sowie `gh` eingeloggt (`gh auth login`).

## Ablauf

### 1. Erkennen (read-only)

Fuehre aus:

```
node "${CLAUDE_PLUGIN_ROOT}/lib/brain-sync.mjs" detect
```

Das gibt JSON zurueck: den GitHub-Account und die erkannten Obsidian-Vaults (mit `open: true` fuer den
zuletzt geoeffneten). Es wird nichts geschrieben.

### 2. Vault waehlen

- Genau ein Vault erkannt -> diesen nehmen.
- Mehrere -> dem User die Liste zeigen und mit **AskUserQuestion** auswaehlen lassen (Default: der mit `open: true`).
- Keiner erkannt -> den User nach dem absoluten Vault-Pfad fragen.

### 3. Einrichten

Fuehre aus (Pfad in Anfuehrungszeichen, kann Leerzeichen enthalten):

```
node "${CLAUDE_PLUGIN_ROOT}/lib/brain-sync.mjs" init --vault "<vault-pfad>"
```

Optionale Flags nur wenn der User es will: `--repo <name>` (Default `obsidian-brain`),
`--index "<relativer/pfad.md>"` (Default `Claude Sessions.md`).

Die Engine legt bei Bedarf das **private** Repo `<account>/obsidian-brain` an, klont es nach
`~/.obsidian-brain-sync/repo` und schreibt `~/.obsidian-brain-sync/config.json`. Idempotent - ein
zweiter Lauf nutzt vorhandenes Repo/Config.

### 4. Bestaetigen

Fasse dem User in 2-3 Zeilen zusammen: welcher Vault, welches private Repo, wo die config liegt.
Nenne als naechsten Schritt: auf dem Quellgeraet `/brain-push`, auf dem Zweitgeraet (nach gleichem
Setup) `/brain-pull`.

## Wichtige Regeln

- **Nie das Daten-Repo public machen** - es enthaelt Session-Logs, die Secrets/personenbezogene Daten enthalten koennen.
- Bei fehlenden Tools nicht raten - die klare Fehlermeldung der Engine an den User weitergeben.
- Auf einem **zweiten Geraet**: dort ebenfalls `/brain-setup` laufen lassen (gleicher GitHub-Account).
  Die Engine klont dasselbe Repo - kein erneutes Anlegen noetig.

_Teil von obsidian-brain-sync._

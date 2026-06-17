---
name: brain-push
description: "Laedt den aktuellen Stand hoch: spiegelt den Obsidian-Vault und alle Claude-Code-Sessions in das private Sync-Repo und pusht zu GitHub. Nutzen am Ende einer Arbeits-Session bzw. bevor man das Geraet wechselt. Trigger DE: 'brain push', 'brain hochladen', 'brain sichern', 'sync hochladen', 'brain rauf', 'push brain', 'stand hochladen'. Trigger EN: 'brain push', 'upload brain', 'sync brain up', 'push my brain'."
---

# Brain Push

Laedt Vault + alle Claude-Sessions ins private Sync-Repo hoch. Auf dem **Quellgeraet** ausfuehren,
bevor du das Geraet wechselst.

Setzt voraus, dass `/brain-setup` auf diesem Geraet schon lief. Fehlt die Config, meldet die Engine
das - dann auf `/brain-setup` verweisen.

## Ablauf

### 1. (Optional) Dry-Run beim ersten Mal

Wenn der User unsicher ist oder es das erste Mal ist, zuerst gefahrlos zeigen, was passieren wuerde:

```
node "${CLAUDE_PLUGIN_ROOT}/lib/brain-sync.mjs" push --dry-run
```

Schreibt/committed nichts, listet aber geplante Aktionen + etwaige Secret-Warnungen.

### 2. Push

```
node "${CLAUDE_PLUGIN_ROOT}/lib/brain-sync.mjs" push
```

### 3. Secret-Warnungen behandeln

Findet die Engine moegliche Geheimnisse, **blockiert** sie den Push (`Push ABGEBROCHEN`, exit 4) -
es wird nichts hochgeladen. Die Treffer dem User **zeigen** und die drei Optionen nennen:
- die betroffene Datei bereinigen, dann erneut pushen,
- einen **bekannten Fehlalarm** (z.B. ein Beispiel-/Dummy-Token) in `config.secretAllowlist`
  als exakten Treffer-String eintragen,
- bewusst trotzdem pushen mit `--allow-secrets`.

Niemals stillschweigend `--allow-secrets` setzen - das ist eine bewusste Entscheidung des Users.

### 4. Zusammenfassen

Dem User in 2-3 Zeilen melden: von welchem Geraet gepusht, wie viele Sessions + Vault-Dateien,
und der Hinweis: auf dem anderen Geraet `/brain-pull` nutzen, um den Stand zu holen.

## Wichtige Regeln

- **Vor der Arbeit `pull`, danach `push`** - das ist die goldene Regel, damit nichts kollidiert.
- Die Engine richtet die interne Arbeitskopie vor dem Push hart am Remote-Stand aus (fetch + reset),
  baut darauf den neuen Stand auf und pusht. Dadurch entstehen keine Merge-Konflikte und kein
  Haengenbleiben an alten, nicht committeten Zwischenstaenden mehr.
- Sessions **und** Vault werden **newer-wins** behandelt; nichts Neueres wird blind ueberschrieben.
- Der Vault-Mirror ist ein **vollstaendiger Schnappschuss** deines Vaults: loeschst du hier eine Notiz,
  verschwindet sie beim naechsten `pull` auch auf dem anderen Geraet (echter Spiegel, sicher abgefedert).
- `Briefings/` bzw. jeder Unterordner mit eigenem `.git` wird automatisch ausgelassen (synct separat).

_Teil von obsidian-brain-sync._

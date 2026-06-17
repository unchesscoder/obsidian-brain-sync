---
name: brain-pull
description: "Holt den neuesten Stand: zieht Vault und Claude-Code-Sessions aus dem privaten Sync-Repo und spielt sie lokal ein, inklusive Path-Remapping, damit 'claude --resume' die Konversationen findet. Vor dem Weiterarbeiten auf einem Geraet ausfuehren. Trigger DE: 'brain pull', 'brain runterladen', 'brain laden', 'sync runterladen', 'brain runter', 'stand holen', 'pull brain'. Trigger EN: 'brain pull', 'download brain', 'sync brain down', 'pull my brain'."
---

# Brain Pull

Holt den neuesten Vault- + Session-Stand aus dem privaten Sync-Repo. Vor dem Weiterarbeiten auf
**diesem** Geraet ausfuehren (z.B. morgens am Standrechner, nachdem du abends am Laptop gepusht hast).

Setzt `/brain-setup` auf diesem Geraet voraus. Fehlt die Config, meldet die Engine das - dann auf
`/brain-setup` verweisen.

## Ablauf

### 1. (Optional) Dry-Run beim ersten Mal

```
node "${CLAUDE_PLUGIN_ROOT}/lib/brain-sync.mjs" pull --dry-run
```

Zeigt, was geholt/ueberschrieben wuerde, ohne etwas zu schreiben.

### 2. Pull

```
node "${CLAUDE_PLUGIN_ROOT}/lib/brain-sync.mjs" pull
```

Die Engine macht **vor** dem Ueberschreiben ein vollstaendiges Vault-Backup unter
`~/.obsidian-brain-sync/backups/<timestamp>/`, spielt dann Vault-Mirror + Sessions ein und remappt
Session-Pfade aufs lokale Home, falls noetig.

### 3. Zusammenfassen

Dem User melden:
- Von welchem Geraet der Stand kommt und von wann (Engine gibt "Letzter Stand: ... von ... @ ...").
- Wie viele Sessions aktualisiert wurden (und ob welche **remapped** wurden).
- Den **Backup-Pfad** (Sicherheit, falls doch etwas lokal ueberschrieben wurde).
- Falls die Engine `lokal neuer - ungepushte Arbeit` meldet: den User warnen, dass er auf diesem
  Geraet ungepushte Sessions hatte; die wurden bewusst NICHT ueberschrieben.

## Wichtige Regeln

- **Vor der Arbeit pullen.** Wer ohne Pull losarbeitet und dann pullt, riskiert Kollisionen
  (abgefedert durch Backup + newer-wins, aber unnoetig).
- Lokale Dateien werden **nie geloescht** - Pull ueberschreibt/ergaenzt nur. Geloeschte Notizen auf dem
  anderen Geraet bleiben hier also bestehen (bewusst, gegen Datenverlust).
- Bei Merge-Konflikt im Repo stoppt die Engine und nennt den Pfad - dem User berichten, nicht raten.
- Cross-OS/anderer-Username: Remapping ist best-effort. Bei gleichem Pfad auf beiden Geraeten (z.B.
  zwei Windows mit gleichem Usernamen) ist Resume exakt.

_Teil von obsidian-brain-sync._

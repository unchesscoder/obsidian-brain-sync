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
- Den **Backup-Pfad** (Sicherheit, falls doch etwas lokal ueberschrieben oder geloescht wurde).
- Wie viele Vault-Dateien aktualisiert und (falls `geloescht` gemeldet) **geloescht** wurden.
- Falls die Engine `lokal neuer - ungepushte Arbeit` oder `Loesch-Konflikt behalten` meldet: den User
  darauf hinweisen, dass dort ungepushte lokale Aenderungen waren, die bewusst NICHT angetastet wurden.

## Wichtige Regeln

- **Vor der Arbeit pullen.** Wer ohne Pull losarbeitet und dann pullt, riskiert Kollisionen
  (abgefedert durch Backup + newer-wins, aber unnoetig).
- **Echter Spiegel mit sicherem Loeschen:** Eine auf dem anderen Geraet geloeschte Notiz wird hier
  beim Pull ebenfalls entfernt - **aber nur**, wenn sie Teil des letzten Sync-Stands war (lokale
  Baseline) und lokal **nicht** geaendert wurde. Lokal neu angelegte Dateien, die die Gegenseite nie
  hatte, werden **nie** geloescht; der allererste Sync (noch keine Baseline) loescht nie. Vor jedem
  Pull wird ohnehin ein volles Backup angelegt. Abschaltbar mit `--no-delete` bzw. `mirrorDelete:false`.
- **Newer-wins** gilt fuer Vault-Notizen **und** Sessions: eine lokal neuer bearbeitete Datei wird NICHT
  von einer aelteren Remote-Version ueberschrieben (Meldung `lokal neuer`). Loeschen-vs-lokale-Aenderung
  wird zugunsten der **lokalen Aenderung** aufgeloest (Meldung `Loesch-Konflikt behalten`).
- Die Engine richtet die interne Arbeitskopie vor dem Pull hart am Remote-Stand aus (fetch + reset).
  Dadurch gibt es keine Merge-Konflikte und kein Haengenbleiben an alten Zwischenstaenden mehr; der
  echte Vault wird davon nie beruehrt (das passiert in einem separaten Verzeichnis).
- Cross-OS/anderer-Username: Remapping ist best-effort. Bei gleichem Pfad auf beiden Geraeten (z.B.
  zwei Windows mit gleichem Usernamen) ist Resume exakt.

_Teil von obsidian-brain-sync._

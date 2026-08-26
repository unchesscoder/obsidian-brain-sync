# Push-Schutz gegen veralteten Vault-Stand

**Datum:** 2026-08-27
**Status:** Design freigegeben

## Problem

`cmdPush` löscht in Schritt 3 den kompletten Mirror (`fs.rmSync(mirrorDir)`) und baut ihn aus dem
lokalen Vault neu auf. Der Push ist damit ein ungeschützter 1:1-Spiegel: alles, was der lokale Vault
nicht kennt, verschwindet aus dem Remote — auch dann, wenn dieses Gerät die Datei nie gepullt hat und
sie gar nicht kennen konnte.

Der Pull hat für Löschungen bereits einen Baseline-Schutz. Der Push hat keinen. Die Asymmetrie ist der
Bug.

### Beobachteter Vorfall (2026-08-26)

Rekonstruiert aus der Commit-Historie von `unchesscoder/obsidian-brain`:

| Zeitpunkt | Ereignis |
|---|---|
| 2026-06-17 | Beide Geräte pushen abwechselnd, Stand konsistent |
| 2026-06-18 | Gerät `Mario` pusht (`eae1b38`): 2 Memory-Notizen, 1 Handoff, Hartl-Digital-AI-Ordner |
| 06-18 bis 08-26 | Nur auf `LENOVO` gearbeitet, kein Push, **kein Pull** |
| 2026-08-26 | `LENOVO` pusht (`c806cc1`) mit einem Vault-Stand von vor dem 18.06. |
| 2026-08-27 | `Mario` pullt, die Löschungen propagieren korrekt weiter |

Schaden: **8 Dateien gelöscht**, **3 Dateien inhaltlich zurückgedreht** (`memory/MEMORY.md` von 9 auf
6 Einträge, `memory/obsidian-brain-sync-plugin.md`, `Agentic OS Tasks.md`).

Beweis, dass es keine bewusste Löschung war: `MEMORY.md` in `c806cc1` ist md5-identisch mit der
Version aus `ed72343` (17.06.). `LENOVO` hat den 18.06.-Stand nie gesehen.

Erschwerend: der Pull meldete routinemässig hunderte Dateien als „lokal neuer", weil `fs.utimesSync`
über ein JS-`Date` (Millisekunden) schreibt, NTFS aber in 100-ns-Ticks speichert. Der Rückvergleich
`mtimeMs > rec.mtime` schlägt dadurch bei unveränderten Dateien an. In diesem Grundrauschen ist der
echte Verlust zwei Monate lang untergegangen.

## Leitprinzip

**Im Zweifel blockieren.** Jeder Zustand, der nicht eindeutig als sicher erkennbar ist, bricht den
Push ab. Ein unnötiger Abbruch kostet einen `brain pull`. Ein unterlassener Abbruch kostet Daten.

## Architektur

Eine reine Funktion trifft die Entscheidung, `cmdPush` orchestriert nur.

```
detectStalePush({ remoteFiles, localFiles, baseline, manifestVault, indexPath })
  -> { deletions: [{ rel }], reversions: [{ rel, localMtime, remoteMtime }], unsafe: [{ rel, grund }] }
```

Kein Dateisystem, kein Git, kein Zustand. Vier Eingaben, ein Ergebnisobjekt. Damit ist die
Entscheidungslogik unit-testbar, ohne einen Git-Roundtrip zu fahren.

`cmdPush` ruft sie auf und bricht bei nicht-leerem Ergebnis ab.

### Aufrufstelle

Direkt nach `loadManifest`, **vor** `fs.rmSync(mirrorDir)`. Danach ist die Remote-Dateiliste
unwiederbringlich weg.

Bricht der Push ab, ist nichts committet und nichts gepusht. Die Arbeitskopie im Repo-Klon kann dabei
verschmutzt zurückbleiben; das ist unkritisch, weil `syncToRemote` sie beim nächsten Lauf per
`fetch + hard reset` ohnehin wieder ausrichtet.

## Regel

Für jede Datei im Remote-Mirror:

| Zustand | Bewertung | Aktion |
|---|---|---|
| lokal fehlt, stand in Baseline, **Remote-mtime ≈ Baseline-mtime** | bewusst gelöscht | durchlassen |
| lokal fehlt, stand in Baseline, **Remote-mtime > Baseline-mtime** | Lösch-/Änderungs-Konflikt | **blockieren** (`deletions`) |
| lokal fehlt, **nie in Baseline** | nie gepullt | **blockieren** (`deletions`) |
| lokal vorhanden, `localMtime < remoteMtime − TOLERANZ` | Rückdrehung | **blockieren** (`reversions`) |
| lokal vorhanden, kein `manifestVault`-Eintrag | Zustand unbekannt | **blockieren** (`unsafe`) |
| lokal vorhanden, sonst | in Ordnung | durchlassen |

Zeile 2 schliesst eine Lücke, die eine reine „steht in der Baseline"-Prüfung offen liesse: Datei hier
gelöscht, auf dem anderen Gerät seit unserem letzten Sync aber geändert. Die Löschung durchzulassen
würde fremde neue Arbeit verwerfen. Nur wenn der Remote noch exakt den Stand hat, den wir zuletzt
gesehen haben, ist die Löschung eindeutig unsere Entscheidung.

`TOLERANZ = 2000` ms. Kein Bauchgefühl: derselbe Wert wird im Pull (`brain-sync.mjs:709`) bereits für
denselben Zweck verwendet, und er deckt sowohl die NTFS-Rundung als auch FAT32-Zeitstempelgranularität
(2 s) ab.

## Grenzfälle

**Session-Index.** `cfg.indexPath` (Default `Claude Sessions.md`) wird von Schritt 2 erst erzeugt und
existiert im Dry-Run lokal gar nicht. Die Datei wird von der Prüfung **ausgenommen**, damit das
Ergebnis nicht von der Aufrufreihenfolge abhängt.

**Keine Baseline.** Frisches Gerät oder gelöschte `vault-baseline.json`. Dann gilt jede Remote-Datei
als „nie gesehen" und der Push blockiert. Das ist gewollt — genau dieses Gerät muss erst pullen. Beim
allerersten Push in ein leeres Repo ist die Remote-Liste leer, es gibt also keinen Fehlalarm.

**Unlesbares Manifest.** `loadManifest` liefert bei kaputtem JSON ein leeres Objekt. Dann fehlen alle
`manifestVault`-Einträge, jede lokal vorhandene Datei landet in `unsafe`, der Push blockiert. Nach
Leitprinzip korrekt.

**Dry-Run.** Fährt dieselbe Prüfung und setzt denselben Exit-Code. Ein `--dry-run`, das nicht vor dem
warnt, was der echte Lauf tut, ist wertlos.

**Excludes.** Die Prüfung vergleicht gegen die Dateiliste, die auch gespiegelt würde (also nach
`makeSkipper`). Sonst meldet jede per `excludes` ausgeschlossene Datei eine Scheinlöschung.

## CLI

- Flag `--allow-stale` — bewusster Override, lässt Löschungen und Rückdrehungen durch
- Exit-Code `5` (`3` = Secret-Fund im Dry-Run, `4` = Secret-Block sind belegt)

**Reihenfolge.** Die Stale-Prüfung läuft vor dem Secret-Scan und bricht zuerst ab. Begründung: sie ist
billig (nur Listenvergleich, kein Dateiinhalt) und ihr Befund ist der grundlegendere — bei veraltetem
Stand ist auch das Secret-Scan-Ergebnis über einen Stand gebildet, der so nicht gepusht werden soll.
Treffen beide zu, gewinnt Exit-Code `5`.

Ausgabeformat:

```
Push ABGEBROCHEN: dieses Geraet hat einen veralteten Stand.

  8 Dateien wuerden GELOESCHT (nie gepullt):
    - memory/plugin-repo-branch-protection.md
    ... und 7 weitere

  3 Dateien wuerden ZURUECKGEDREHT (remote ist neuer):
    - memory/MEMORY.md          remote 18.06. > lokal 17.06.

Optionen:
  - erst 'brain pull', dann erneut pushen
  - bewusst trotzdem: --allow-stale

(nichts wurde committet oder gepusht)
```

Lange Listen werden auf 25 Einträge gekürzt, analog zum Secret-Scan.

## Begleitfix: Toleranz im Pull

Dieselbe 2-Sekunden-Toleranz kommt in die beiden Newer-wins-Vergleiche des Pulls
(`brain-sync.mjs:725` Vault, `:784` Sessions). Das beseitigt die Fehlalarme aus der
`utimesSync`-Rundung.

Das ist kein kosmetisches Extra: ein Schutz, dessen Meldungen im Grundrauschen untergehen, schützt
nicht. Genau daran ist der Vorfall zwei Monate lang unbemerkt geblieben.

## Tests

`tests/sandbox-test.mjs` läuft gegen ein lokales Bare-Repo, ohne GitHub. Aktuell 32 Fälle.

Unit-Tests für `detectStalePush`:

1. Löschung **mit** Baseline-Eintrag, Remote unverändert → durchlassen
2. Löschung **ohne** Baseline-Eintrag → `deletions`
2b. Löschung mit Baseline-Eintrag, aber Remote seither geändert → `deletions`
3. Lokale Datei älter als Remote → `reversions`
4. mtime-Differenz unter Toleranz → durchlassen
5. Lokale Datei ohne Manifest-Eintrag → `unsafe`
6. `indexPath` fehlt lokal → nie gemeldet
7. Leere Remote-Liste → leeres Ergebnis
8. Fehlende Baseline (`null`) → alle Remote-Dateien in `deletions`

Integrationstests:

9. Push mit veraltetem Vault bricht ab, Exit-Code 5, Remote unverändert
10. Derselbe Push mit `--allow-stale` läuft durch
11. Dry-Run meldet dasselbe und setzt denselben Exit-Code
12. LENOVO-Szenario end-to-end: A pusht, B pusht ohne Pull → Abbruch
13. Pull-Toleranz: unveränderte Datei nach Pull wird beim nächsten Pull nicht als „lokal neuer" gemeldet

## Bewusst nicht enthalten

- **Automatischer Pull im Push.** Der Push würde zwei Dinge tun und könnte lokale Dateien
  überschreiben, ohne dass der Nutzer es erwartet. Abbrechen und den Nutzer entscheiden lassen ist
  ehrlicher.
- **Newer-wins für Vault-Inhalte im Push.** Wäre eine echte Merge-Strategie statt eines Spiegels.
  Grössere Änderung, anderes Problem.
- **Schutz für Sessions.** Der Push hat für Sessions bereits einen Newer-wins-Check
  (`rec.mtime > localMtime` → „remote neuer"). Nur der Vault ist ungeschützt.

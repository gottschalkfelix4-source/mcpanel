# Bug-Audit und Umsetzungsstand

Stand: 08.09.2026. Ausgangspunkt des Audits: Commit `4596e7e`.
**Für alle 35 Befunde sind Codekorrekturen implementiert.** Der Minecraft-Proxy für
individuelle Server-Subdomains ist einschließlich API und Oberfläche implementiert.
Die Änderungen liegen im Arbeitsverzeichnis; sie sind noch nicht produktiv ausgerollt.
Eine vollständige Fehlerfreiheit lässt sich aus diesem Audit nicht ableiten.

## Verifikation

- Backend- und Frontend-Build erfolgreich.
- **139 automatisierte Prüfungen** ohne externe Dienste bestanden.
- **8 Integrationstests** mit isolierter PostgreSQL-18-Datenbank bestanden: Setup-Rennen,
  Portreservierung, Erstellungs-/Löschfehler, Passwortwiderruf, Hostnamen-Eindeutigkeit,
  Admin-API und Rechteentzug bei einer offenen WebSocket-Verbindung.
- **4 Tests mit dem offiziellen mc-router 1.46.5 Binary** bestanden: zwei Zielbackends,
  Alias, Status-/Login-Handshakes einschließlich Forge-Suffix, unbekannte Namen und
  Routenwechsel per atomarer Datei plus SIGHUP. Ziele sind TCP-Testserver, keine
  vollständigen Minecraft-Installationen.
- Browserprüfung mit echter Panel-API und temporärer Datenbank, simulierter Docker-API:
  Proxy-Portkonflikt verständlich dargestellt, öffentlicher Host speicherbar und in
  Serveradressen übernommen, Aliase nach Neuladen erhalten; Kontowechsel Admin → Mitglied zeigt nur den zugewiesenen Server und entfernt Admin-Navigation.
- `docker compose config`: leerer HOST_DATA_ROOT, absolut aufgelöster Daten-Mount und
  MC_IMAGE-Weitergabe geprüft. PWA-Icons lokal erzeugt; Shell-Syntax geprüft.
- **Offene Betriebsabnahme:** echte Docker-Builds/Bind-Mounts und Prozessausfälle im
  Alles-in-einem-Abbild; echte SMB-/S3-Dienste; vollständige Minecraft-Logins mit den
  tatsächlich verwendeten Loadern und externe DNS-/Firewall-Konfiguration.
  Der echte Docker-Socket ist hier nicht zugänglich. Diese Prüfungen sind nicht als
  bestanden gewertet und müssen vor Produktivfreigabe erfolgen.
- Laufzeit lokal: Node 26.8.1; Dockerfiles verwenden Node 22. Keine Last-/CVE-Prüfung.

## Fixnachweise je Befund

„Codeprüfung“ bedeutet implementiert und gebaut, aber kein eigener automatisierter
End-to-End-Nachweis für genau diesen Ablauf. Die folgenden ursprünglichen Befunde
bleiben als Hintergrund erhalten; dortige Zeilennummern beziehen sich auf den Auditstand.

| ID | Änderung | Nachweis |
|---|---|---|
| 01 | Komponentenweise Pfadgrenze, Symlinks abweisen | `audit/reproduce.test.ts` |
| 02 | ZIP-Pfade vor allen Schreibzugriffen validieren | `audit/reproduce.test.ts` |
| 03 | Ersteinrichtung mit DB-Transaktion und Tabellensperre | `audit/integration.test.ts` |
| 04 | Frische Konto-/Mitgliedsrechte für Socket-Aktionen und ausgehende Ereignisse | `audit/integration.test.ts` |
| 05 | Verwaltete Properties auch aus `values` entfernen | `audit/reproduce.test.ts` |
| 06 | Property-Schlüssel/-Werte gegen Zeileninjektion prüfen | `audit/reproduce.test.ts` |
| 07 | Socket und Query-Cache bei Kontowechsel/Logout/401 verwerfen | Codeprüfung `auth.tsx` + Browser-Kontowechsel |
| 08 | Backup-Service nutzt gemeinsame reentrante Serversperre | `operations.test.ts`, Codeprüfung Automation |
| 09 | Tasks, Power, Dateien, Konfiguration, Content und Automationen koordinieren | `operations.test.ts`, `modpack.install.test.ts` |
| 10 | Verzeichniswechsel mit Journal; Altbestand und Metadaten wiederherstellen; Container vor Autostart abgleichen | `backups.test.ts`, `audit/recovery.test.ts`, `modpack.install.test.ts` |
| 11 | Compose-Default leer; erkannte/angegebene Hostpfade validieren | Compose-Konfiguration; echter Bind-Mount offen |
| 12 | Environment-Inhalt vergleichen statt bloßes Vorhandensein | `audit/reproduce.test.ts` |
| 13 | Nicht geladene Umgebung nicht mitsenden | Codeprüfung `SettingsTab.tsx` |
| 14 | Heap-/RCON-/Port-Umgebungswerte reservieren; Quotas nur Admin | Codeprüfung `docker.ts`, Serverroute |
| 15 | Download in temporäre Datei; atomar ersetzen | HTTP-/Stream-/Quota-Regressionen in `audit/reproduce.test.ts` |
| 16 | Pflichtdownload-Fehler abbrechen; Dateien und Bindung zurückrollen | `modpack.install.test.ts` |
| 17 | Automation wartet auf Taskabschluss und übernimmt Fehler | `tasks.test.ts`, Codeprüfung Automation |
| 18 | Port in transaktionaler Servererstellung reservieren | `audit/integration.test.ts` |
| 19 | Gewünschte belegte Ports ablehnen; Docker-Bindefehler als Konflikt melden | Regressionstest; echter Host-Bindefehler offen |
| 20 | Nur Docker-404 ignorieren; Daten erst nach erfolgreicher Entfernung löschen | `audit/integration.test.ts` |
| 21 | Geplante Stopps/Kills auch im Crash-Scheduler beachten | Codeprüfung `docker.ts`, `automation.ts` |
| 22 | Layout und Konsole abonnieren bei jedem Connect erneut | Codeprüfung; wiederholter Netzwerkabriss noch offen |
| 23 | Livezustand bei Serverwechsel/Disconnect zurücksetzen und HTTP aktualisieren | Codeprüfung `ServerLayout.tsx` |
| 24 | Öffentlichen Host im Panel/API ändern | Browserprüfung inklusive aktualisierter Serveradressen |
| 25 | Node, nginx und PostgreSQL überwachen; bei Ausfall Container beenden | Shell-Syntax/Codeprüfung; echter Containertest offen |
| 26 | PWA-Icons auch im Wurzel-Dockerfile erzeugen | Lokale Icon-Erzeugung + Frontend-Build; Imageprüfung offen |
| 27 | SMB ohne Shell, Credentials-Datei mit Modus 0600 | `backupTarget.test.ts` |
| 28 | Mount vor jeder SMB-Kopie sicherstellen, Fehler weitergeben | `backupTarget.test.ts` |
| 29 | Unveränderliche Zielversion je gespiegeltem Backup speichern | `backupTarget.test.ts` + Schema in Test-DB |
| 30 | S3-Download über Pipeline mit Fehlerweitergabe/Timeout/Aufräumen | `backupTarget.test.ts` |
| 31 | Sitzungsrevision bei Passwortwechsel/-Reset erhöhen | `audit/integration.test.ts` |
| 32 | Wachstum bei Editor, Upload, Download, ZIP, Backup und Modpack begrenzen | `byteLimit.test.ts`, Upload-/Download-Regressionen; Codeprüfung übriger Pfade |
| 33 | MC_IMAGE von Compose ins Backend weiterreichen | `docker compose config` mit Override |
| 34 | Fehlgeschlagene Erstellung kompensieren; bei unklarem Dockerzustand Daten erhalten | `audit/integration.test.ts` |
| 35 | Konfigurierte Welten und keepConfig in Downloads und Overrides schützen | `modpack.install.test.ts` |

## Tests erneut ausführen

```sh
cd backend
npm ci
npm run build
npm test
```

Die beiden Integrationstest-Dateien werden ohne ihre Umgebungsvariablen übersprungen.
Nur mit einer **wegwerfbaren** Datenbank ausführen: der DB-Test leert Tabellen.
`AUDIT_DATABASE_URL` muss auf die Datenbank `mcpanel_audit` auf localhost zeigen,
`DATA_ROOT` auf einen neuen temporären Ordner. Schema vorher mit `prisma db push`
in dieser Testdatenbank anlegen. `MC_ROUTER_BIN` verweist auf das offizielle Binary.
Keinesfalls eine produktive DATABASE_URL verwenden.

```sh
AUDIT_DATABASE_URL=postgresql://TESTUSER@127.0.0.1:TESTPORT/mcpanel_audit \
DATA_ROOT=/tmp/mcpanel-test-NEUER-LAUF \
MC_ROUTER_BIN=/absoluter/pfad/mc-router \
npx vitest run audit/integration.test.ts audit/router.test.ts
```

## Ursprüngliche Befunde

**R** = im ursprünglichen Audit reproduziert; **C** = damals durch Codeanalyse gefunden.
**P1** = Sicherheit/Datenverlust/Ausfall; **P2** = Funktion/Bedienung.
Aktueller Umsetzungsstand steht in der Tabelle oben, nicht in diesen historischen Beschreibungen.

## Sicherheit und Zugriffsgrenzen

### BUG-01 — P1 / R — Symlinks umgehen die Dateisystemgrenze

- **Stelle:** `backend/src/services/files.ts:26`, insbesondere Lesen, Schreiben, Upload und Download.
- **Auslöser/Folge:** Ein im Serverordner vorhandener Symlink zeigt außerhalb dieses Ordners. `resolveSafe` prüft nur den Pfadtext; die Dateioperation folgt dem Link. Lesen und Überschreiben außerhalb des zugewiesenen Servers sind reproduziert. Voraussetzung ist ein vorhandener Link, etwa durch Servercode oder importierte Daten; der Dateimanager selbst bietet keinen Symlink-Knopf.
- **Abnahme:** Auch bestehende Pfadkomponenten und Schreibziele sicher begrenzen; Tests für Datei- und Verzeichnislinks, Downloads, Uploads und Entpacken. Fremde Serverdaten und Paneldateien bleiben unerreichbar.

### BUG-02 — P1 / R — ZIP-/Modpack-Pfadschutz akzeptiert Geschwister mit gleichem Präfix

- **Stellen:** `backend/src/services/files.ts:149`; dieselbe Prüfung in `backend/src/services/modpack.ts` beim Download und in `extractOverrides`.
- **Auslöser/Folge:** Ziel `servers/a`, Archiveintrag `../a-other/escaped.txt`: `startsWith(root)` akzeptiert den fremden Geschwisterordner. Der Dateimanager-Fall ist mit einem echten ZIP reproduziert. Beim Modpack gilt derselbe Fehler auch für Manifest-Downloadpfade.
- **Abnahme:** Pfadkomponentengrenzen prüfen, ungültige Archive vor Änderungen ablehnen; gemeinsame Schutzfunktion einschließlich BUG-01. Auch ähnlich beginnende echte Server-IDs testen.

### BUG-03 — P1 / C — Gleichzeitige Ersteinrichtung kann mehrere Administratoren erzeugen

- **Stelle:** `backend/src/routes/setup.ts:87`.
- **Auslöser/Folge:** Zwei Anfragen mit unterschiedlichen Kontonamen sehen beide `user.count() === 0`, warten auf bcrypt und legen anschließend jeweils einen Administrator an. Prüfung und Erstellung sind nicht atomar.
- **Abnahme:** Einrichtung atomar auf genau einen Gewinner beschränken; parallele Requests ergeben einen Erfolg und eine eindeutige Ablehnung, auch bei mehreren Backend-Prozessen.

### BUG-04 — P1 / C — Rechteentzug wirkt nicht zuverlässig auf offene WebSockets

- **Stellen:** `backend/src/ws/console.ts:104`, `:116`, `:153`; `backend/src/auth/context.ts`.
- **Auslöser/Folge:** Rolle und Aktivstatus werden beim Verbindungsaufbau in `socket.data.user` gespeichert. Ein danach deaktivierter Benutzer mit weiter bestehender Mitgliedschaft kann Befehle senden; ein herabgestufter Admin behält im Socket seine alte Adminrolle. Bereits abonnierte Räume liefern Logs auch nach Entfernen der Mitgliedschaft weiter. Tokenablauf wird nicht erneut geprüft.
- **Abnahme:** Änderungen an Konto, Rolle, Mitgliedschaft und Token-Gültigkeit greifen auch für bestehende Verbindungen; Raumzugriff und Befehle nach Entzug unterbinden.

### BUG-05 — P2 / R — Konfigurationsantwort enthält vermeintlich ausgeblendetes RCON-Passwort

- **Stellen:** `backend/src/services/properties.ts:105`, `:118`; `backend/src/routes/config.ts`.
- **Auslöser/Folge:** `MANAGED_KEYS` werden nur aus `extra`, nicht aus `values` entfernt. `GET config/properties` liefert daher `rcon.password` an Benutzer mit `files.read`. Das ist keine zusätzliche Rechteeskalation gegenüber dem derzeit ebenfalls erlaubten Rohdatei-Lesen, widerspricht aber der vorgesehenen Ausblendung und verbreitet das Geheimnis unnötig.
- **Abnahme:** Verwaltete Geheimnisse aus der Formularantwort entfernen; die gewünschte Geheimnisgrenze auch für Rohdateien und effektive Umgebung ausdrücklich festlegen.

### BUG-06 — P2 / R — Zeilenumbrüche umgehen den Schutz verwalteter Properties

- **Stelle:** `backend/src/services/properties.ts:122` / `mergeProperties`.
- **Auslöser/Folge:** Ein erlaubter Wert wie `motd: "hello\nrcon.password=changed"` erzeugt einen zusätzlichen geschützten Schlüssel. `config.edit` reicht aus, `files.write` ist dafür nicht erforderlich. Verbindungsparameter können dadurch vom Panelstand abweichen.
- **Abnahme:** Schlüssel und Werte nach Java-Properties-Regeln validieren/escapen; keine zusätzlichen Schlüssel durch CR/LF, Separatoren oder Escapevarianten.

### BUG-07 — P1 / C — Kontowechsel übernimmt alte Socket-Identität und Query-Daten

- **Stellen:** `frontend/src/lib/auth.tsx:60`, `frontend/src/lib/socket.ts`; `frontend/src/main.tsx`.
- **Auslöser/Folge:** Abmelden leert nur Token und React-Benutzer. `resetSocket()` wird nirgends aufgerufen, der Query-Cache bleibt erhalten. Nach Admin → Logout → Benutzer im selben Tab nutzt die gemeinsame Socket-Verbindung weiterhin die Adminidentität; zwischengespeicherte Antworten können kurzzeitig fremde Daten anzeigen.
- **Abnahme:** Logout, Login und Sitzungswechsel trennen Socket und löschen kontobezogene Queries; zwei Konten im selben Tab dürfen keine Daten oder Befehlsrechte übernehmen.

### BUG-31 — P2 / C — Passwortänderung/-Reset widerruft alte Sitzungen nicht

- **Stellen:** `backend/src/routes/auth.ts:81`, `backend/src/routes/users.ts`, `backend/src/auth/jwt.ts`, `backend/src/auth/context.ts`.
- **Auslöser/Folge:** Nach Änderung des Passworts ist ein zuvor kopiertes JWT weiterhin gültig, standardmäßig bis zu sieben Tage. Es gibt keine Sitzungsrevision oder Widerrufszeit.
- **Abnahme:** Passwortreset kann bestehende Sitzungen wirksam entziehen; HTTP und WebSocket verwenden denselben Widerrufsmechanismus. Gewünschten Umgang mit der aktuellen eigenen Sitzung festlegen.

## Datenintegrität, Backups und Aufgaben

### BUG-08 — P1 / C — Automatische Backups umgehen die Aufgabensperre

- **Stellen:** `backend/src/services/automation.ts:113`; `backend/src/services/tasks.ts`.
- **Auslöser/Folge:** BACKUP ruft direkt `createBackup` auf, während manuelle Sicherungen/Restore/Modpack-Tasks über `runTask` gesperrt werden. Ein Zeitplan-Backup kann deshalb einen halb aktualisierten oder halb wiederhergestellten Server sichern; mehrere automatische Backups können sich überlagern.
- **Abnahme:** Gemeinsame Sperre für automatische und manuelle Operationen; konfliktbehaftete Vorgänge warten oder liefern einen klaren Konflikt. Ein internes Sicherheitsbackup innerhalb einer bereits gesperrten Modpack-Installation darf keinen Deadlock erzeugen.

### BUG-09 — P1 / C — Starten, Löschen, Einstellungen und Dateiänderungen laufen während Restore/Installation weiter

- **Stellen:** `backend/src/routes/servers.ts`, `backend/src/routes/files.ts`, `backend/src/routes/content.ts`; `backend/src/services/tasks.ts`.
- **Auslöser/Folge:** Während eines Restore-/Modpack-Tasks startet ein zweiter Request den Server, löscht ihn oder verändert dieselben Dateien. Diese Pfade prüfen die Aufgabensperre nicht. Der Server kann mit unvollständigen Daten starten; Löschung und Task können verwaiste Dateien/Container erzeugen.
- **Abnahme:** Definierte Konfliktmatrix und serverweite Koordination auch außerhalb `runTask`; gezielt Restore + Start/Löschen/Dateischreiben testen.

### BUG-10 — P1 / C — Wiederherstellung verliert Daten nach Abbruch beim Beiseitelegen

- **Stellen:** `backend/src/services/backups.ts:177`, `:212`, `:217`.
- **Auslöser/Folge:** Abbruch nach dem Verschieben nur eines Teils der Dateien nach `.restore-old`. Der nächste Lauf behandelt den Ordner als vollständig und löscht alle übrigen Originaldateien außerhalb davon. Scheitert die neue Extraktion, kann der behauptete alte Stand nicht vollständig zurückgeholt werden. Die vorhandenen Tests behandeln nur einen vollständig gefüllten Stash.
- **Abnahme:** Wiederanlauf kennt die Phase und bereits verschobene Einträge. Abbruch nach jedem einzelnen Rename plus anschließender Extraktionsfehler muss den vollständigen Ausgangsstand erhalten. Autostart darf einen unterbrochenen Restore nicht ungeprüft starten.

### BUG-15 — P1 / R — Fehlgeschlagener Download löscht die bereits vorhandene Mod

- **Stellen:** `backend/src/lib/download.ts`; `backend/src/routes/content.ts`.
- **Auslöser/Folge:** Installieren einer Datei unter bestehendem Namen, Gegenstelle liefert bereits beim ersten Request HTTP 503. Der Catch entfernt `destination`, obwohl die vorhandene Datei noch gar nicht ersetzt wurde. Bei Streamfehlern wird sie zuvor direkt abgeschnitten.
- **Abnahme:** Download in eindeutige temporäre Datei; erst nach vollständiger Prüfung atomar ersetzen. HTTP-/Streamfehler erhalten die ursprüngliche Datei bytegenau.

### BUG-16 — P1 / C — Unvollständige Modpacks werden als installiert gespeichert

- **Stelle:** `backend/src/services/modpack.ts`, `planFromCurseforge` und Download-Worker.
- **Auslöser/Folge:** Fehlende Metadaten/URLs werden übersprungen; fehlgeschlagene Downloads nur protokolliert. Danach werden Versionsbindung und Container aktualisiert und gegebenenfalls gestartet. Eine Pflicht-Mod kann fehlen, während der Task `DONE` meldet; bei übersprungenen Metadaten fehlt sogar der abschließende Fehlerzähler.
- **Abnahme:** Fehlende Pflichtdateien führen zum fehlgeschlagenen Installationszustand. Vorherige funktionsfähige Installation und Versionsbindung erhalten oder nachvollziehbar zurückrollen; optionale Dateien separat behandeln.

### BUG-17 — P2 / C — Automatisches Modpack-Update meldet Erfolg vor dem Ergebnis

- **Stellen:** `backend/src/services/automation.ts:149`; `backend/src/services/tasks.ts`.
- **Auslöser/Folge:** `await runTask()` wartet lediglich auf die Task-ID. Die Regel bekommt unmittelbar `OK` und kann eine Erfolgsmeldung schicken, obwohl die Installation später scheitert. Der Fehler des Tasks aktualisiert die Regel nicht.
- **Abnahme:** „Gestartet“ und „erfolgreich beendet“ unterscheiden; Abschluss und Fehler des Tasks in Regelstatus und Benachrichtigungen übernehmen.

### BUG-20 — P1 / C — Docker-Löschfehler werden verschluckt, Daten werden trotzdem gelöscht

- **Stellen:** `backend/src/services/docker.ts:104`, `:241`; `backend/src/services/serverManager.ts:79`.
- **Auslöser/Folge:** Docker-Inspect oder Remove liefert etwa einen Verbindungs-/Berechtigungsfehler. Der Code behandelt dies wie „Container fehlt/bereits weg“. `deleteServer` entfernt anschließend Datenbankeintrag und Dateien, obwohl der Container noch laufen kann.
- **Abnahme:** Nur tatsächliches Nichtvorhandensein ignorieren. Bei anderen Docker-Fehlern bleiben Datensatz und Dateien erhalten und die API meldet den Fehler.

### BUG-27 — P1 / C — SMB-Zugangsdaten werden unescaped in eine Shell eingesetzt

- **Stellen:** `backend/src/services/backupTarget.ts:236`, `:252`; `backend/src/routes/settings.ts`.
- **Auslöser/Folge:** Ein legitimes Kennwort mit Apostroph zerbricht die Shell-Quotes; Kommas verändern die CIFS-Optionsliste. Präparierte Werte können Shell-Code einschleusen. Eingabe ist Admin-only, also keine eigenständige Eskalation eines normalen Mitglieds. Die Fehlermaskierung endet ebenfalls an Komma/Apostroph und kann Kennwortreste anzeigen.
- **Abnahme:** Shellfreie Prozessargumente und geschützte CIFS-Credentials-Datei; Sonderzeichenkennwörter funktionieren und erscheinen weder in Fehlermeldungen noch Prozessargumenten.

### BUG-28 — P1 / C — Fehlender SMB-Mount produziert eine vermeintlich erfolgreiche Zweitkopie

- **Stellen:** `backend/src/bootstrap.ts`; `backend/src/services/backupTarget.ts:304`.
- **Auslöser/Folge:** Einhängen beim Backend-Start scheitert, das Panel läuft weiter. `putBackup` prüft den Mount nicht und schreibt mit `mkdir/copyFile` unter den lokalen Mountpunkt. Das Backup erhält `mirrored=true`, obwohl keine NAS-Kopie existiert.
- **Abnahme:** Vor jedem Schreiben das tatsächliche Ziel prüfen; ohne korrekten Mount kein lokaler Ersatzpfad und kein `mirrored=true`. Wiederverbindung zuverlässig behandeln.

### BUG-29 — P1 / C — Wechsel der Zweitablage macht alte ausgelagerte Backups unauffindbar

- **Stellen:** `backend/prisma/schema.prisma` (`Backup`); `backend/src/services/backupTarget.ts:350`; `backend/src/services/backups.ts:31`.
- **Auslöser/Folge:** Backup wird auf Ziel A gespiegelt, lokale Datei geht verloren, anschließend wird Ziel B konfiguriert. Am Backup steht nur `mirrored`, keine Zielidentität; Abruf sucht ausschließlich auf B. Die vorhandene Sicherung auf A ist im Panel nicht mehr abrufbar.
- **Abnahme:** Zielreferenz/Objektpfad am Backup speichern; alte Ziele für Restore verfügbar halten oder eine explizite Migration anbieten. Historische Spiegelstatus dürfen keinen Zugriff auf das neue Ziel suggerieren.

### BUG-30 — P1 / C — S3-Download behandelt Fehler des Quellstreams nicht

- **Stelle:** `backend/src/services/backupTarget.ts:371`.
- **Auslöser/Folge:** Die Verbindung bricht nach `GetObject` während des Lesens ab. Fehlerhandler hängen nur am Zielstream; `pipe()` reicht Quellfehler nicht automatisch weiter. Die Promise kann hängen oder ein unbehandeltes Error-Event verursachen; temporäre Teildateien werden bei Fehlern nicht zuverlässig aufgeräumt. Zeitstempelbasierte Dateinamen können zudem bei parallelen Abrufen kollidieren.
- **Abnahme:** `pipeline` mit Fehlerweitergabe, eindeutiges temporäres Verzeichnis und Cleanup bei Erfolg/Abbruch/Fehler; reproduzierbarer Verbindungsabbruch im Integrationstest.

### BUG-32 — P1 / C — Speicherkontingente begrenzen neue Schreibvorgänge nicht

- **Stellen:** `backend/src/services/quota.ts:71`, `backend/src/routes/files.ts`, `backend/src/services/backups.ts:63`, `backend/src/routes/content.ts`.
- **Auslöser/Folge:** Backup und Upload prüfen nur den vorherigen Stand, immer mit `extraBytes=0`; genau am Limit ist Schreiben noch erlaubt (`>`). Eine große Datei kann das Limit weit überschreiten. Editor, Entpacken und Content-Installationen prüfen es gar nicht.
- **Abnahme:** Zuwachs vorab oder während des Schreibens begrenzen, inklusive paralleler Vorgänge und entpackter Größe; abgebrochene Schreibvorgänge aufräumen. Tests knapp unter, exakt auf und über dem Limit.

### BUG-35 — P1 / C — Modpack-Overrides können die bestehende Welt überschreiben

- **Stelle:** `backend/src/services/modpack.ts`, `extractOverrides` und Download-Worker.
- **Auslöser/Folge:** `overrides/world/level.dat` wird direkt über eine vorhandene Welt geschrieben. Die Schutzliste enthält einzelne Properties-/Spielerdateien, aber keine Weltordner. Außerdem durchlaufen Manifest-Downloads weder diese Schutzliste noch `keepConfig`. Das widerspricht der zugesagten Erhaltung von Welt und Spielerdaten beim Update.
- **Abnahme:** Alle Installationspfade schützen bestehende Welten einschließlich eigenem `level-name` und Dimensionen sowie verwaltete Dateien; `keepConfig` gilt auch für Manifest-Downloads. Update-Test mit absichtlich mitgelieferten Welt-/Konfigurationsdateien.

## Serverbetrieb und Bereitstellung

### BUG-11 — P1 / C — Compose-Standard blockiert die Hostpfad-Erkennung

- **Stellen:** `docker-compose.yml:38`; `backend/src/bootstrap.ts` (Prüfung `!process.env.HOST_DATA_ROOT`).
- **Auslöser/Folge:** Schnellstart ohne `.env` setzt im Backend `HOST_DATA_ROOT=./data`. Dadurch läuft keine automatische Erkennung. Minecraft-Bind-Mounts erhalten den relativen Pfad `./data/servers/<id>`, während sie einen Hostpfad benötigen; Containererstellung scheitert bzw. bindet nicht die vorgesehenen Daten.
- **Abnahme:** Compose ohne `.env` erkennt den absoluten Mount-Quellpfad; explizite Hostpfade werden validiert. Server erstellen/starten und eine identische Datei aus Panel und Minecraft-Container lesen.

### BUG-12 — P2 / R — Jedes Speichern in den Einstellungen startet den Server neu

- **Stellen:** `backend/src/services/serverManager.ts:109`; `frontend/src/pages/server/SettingsTab.tsx:72`.
- **Auslöser/Folge:** Die Oberfläche sendet stets `extraEnv`, selbst unverändert. Das Backend wertet schon dessen Vorhandensein als Änderungsgrund. Auch nur Umbenennen oder Speichern ohne Änderungen stoppt und ersetzt den Container.
- **Abnahme:** Inhalt statt Vorhandensein vergleichen. Name/Beschreibung/Autostart/Kontingent und unveränderte Umgebung erzeugen keinen Neustart; echte Laufzeitänderungen weiterhin übernehmen.

### BUG-13 — P1 / C — Speichern vor dem Laden der Umgebung löscht Einstellungen

- **Stelle:** `frontend/src/pages/server/SettingsTab.tsx:30`, `:44`, `:72`.
- **Auslöser/Folge:** `env` beginnt als leere Liste. Bei langsamer/fehlgeschlagener Environment-Abfrage bleibt Speichern aktiv und sendet `{}`. Ein Admin kann dadurch unter anderem Loader-Versionen und Image-Overrides unbeabsichtigt entfernen und sofort den Container neu erzeugen.
- **Abnahme:** Unbekannte Umgebung nicht mitsenden bzw. Speichern bis zum erfolgreichen Laden sperren. Netzwerkfehler und sofortiges Speichern bei vorhandenem Override testen.

### BUG-14 — P2 / C — Heap-Quota lässt sich über `extraEnv` umgehen

- **Stellen:** `backend/src/services/docker.ts:122`, `:133`; `backend/src/routes/servers.ts`, `assertProtectedEnvUnchanged`.
- **Auslöser/Folge:** Ein Mitglied mit `settings.edit` setzt `MEMORY`/`MAX_MEMORY` in der Umgebung statt `memoryMb`. Die Heap-Prüfung sieht nur `memoryMb`, die Umgebung überschreibt anschließend die Vorgabe. Das Docker-Gesamtlimit bleibt erhalten; die zugesagte Heap-Grenze und Anzeige stimmen jedoch nicht mehr, OOMs werden möglich.
- **Abnahme:** Sämtliche Heap-Konfigurationswege validieren oder reservieren; dieselbe validierte Quelle für Java-Heap, Quota und Anzeige verwenden.

### BUG-18 — P2 / R — Gleichzeitiges Anlegen konkurriert um denselben Port

- **Stelle:** `backend/src/services/serverManager.ts:33`.
- **Auslöser/Folge:** Zwei Zuteilungen lesen dieselbe Portliste und liefern beide 25565. Die Unique-Constraint verhindert doppelte DB-Einträge, aber eine Erstellung scheitert statt den nächsten Port zu nutzen; der generische Fehlerhandler meldet 500.
- **Abnahme:** Atomare Reservierung oder kontrollierter Retry bei Unique-Konflikt; parallele Erstellung nutzt unterschiedliche Ports oder meldet echte Erschöpfung.

### BUG-19 — P2 / R — Ein ausdrücklich gewünschter belegter Port wird still ersetzt

- **Stelle:** `backend/src/services/serverManager.ts:35`.
- **Auslöser/Folge:** Bei angefordertem Port 25565 und bestehendem Server auf 25565 wird 25566 vergeben. Vorbereitete DNS-/Firewall-Konfiguration zeigt dann auf den falschen Port. Außerdem berücksichtigt die automatische Vergabe nur DB-Einträge, keine anderen Hostdienste.
- **Abnahme:** Expliziter Portkonflikt wird verständlich abgelehnt; automatisch vergebene Ports auf tatsächliche Bindbarkeit prüfen bzw. Bindefehler gezielt behandeln.

### BUG-21 — P1 / C — „Nach Absturz“ feuert auch nach absichtlichem Kill

- **Stellen:** `backend/src/services/automation.ts:254`; `backend/src/services/docker.ts:304`; `backend/src/services/notify.ts`.
- **Auslöser/Folge:** Kill über das Panel hinterlässt einen Fehler-Exitcode. Nur der Benachrichtigungs-Wächter verwendet die Planned-Stop-Markierung; der Scheduler prüft ausschließlich vorher laufend → jetzt error. Eine ON_CRASH-START-Regel startet den bewusst abgeschalteten Server wieder.
- **Abnahme:** Gemeinsame Unterscheidung geplanter und ungeplanter Stopps für Scheduler und Benachrichtigungen; Kill/Stop/Neuerstellung lösen keine Crash-Regel aus.

### BUG-25 — P1 / C — Alles-in-einem-Container überwacht nur Node

- **Stelle:** `docker/entrypoint.sh:94`, `:97`.
- **Auslöser/Folge:** nginx läuft daemonisiert; das Skript wartet nur auf `NODE_PID`. Stirbt nginx oder PostgreSQL bei weiterlaufendem Node, bleibt der Container aktiv. Ein fehlgeschlagener Healthcheck allein löst bei normalem Docker keine Neustartpolicy aus. Die behauptete Überwachung aller drei Dienste fehlt.
- **Abnahme:** Ausfall jedes kritischen Dienstes führt zu definiertem Shutdown und einem von der Restartpolicy erfassten Container-Ende; alle drei Ausfälle im Container testen.

### BUG-26 — P2 / C — PWA-Icons fehlen im Alles-in-einem-Abbild

- **Stellen:** `Dockerfile` (Frontend-Baustufe); `frontend/Dockerfile`; `frontend/public/manifest.webmanifest`.
- **Auslöser/Folge:** Die PNG-Icons sind nicht eingecheckt. Nur `frontend/Dockerfile` ruft `scripts/gen-icons.mjs` auf; das Wurzel-Dockerfile tut dies nicht. Das für Unraid gedachte Abbild liefert die im Manifest referenzierten Icons nicht korrekt.
- **Abnahme:** Beide Bauwege erzeugen dieselben Icons; jede Manifest-Icon-URL liefert ein gültiges Bild mit passender Größe.

### BUG-33 — P2 / C — Dokumentiertes `MC_IMAGE` wird von Compose nicht weitergereicht

- **Stellen:** `docker-compose.yml` (Backend-Umgebung); `backend/src/config.ts`.
- **Auslöser/Folge:** `MC_IMAGE` in `.env` setzen und Stack neu erstellen: Compose interpoliert nur explizit referenzierte Werte; `MC_IMAGE` fehlt in `environment`. Das Backend verwendet weiter die automatische Imagewahl.
- **Abnahme:** Dokumentierte unterstützte Umgebungswerte vollständig durchreichen und mit `docker compose config` sowie Backend-Systemansicht prüfen.

### BUG-34 — P2 / C — Fehlgeschlagene Servererstellung hinterlässt einen angelegten Server

- **Stelle:** `backend/src/services/serverManager.ts:47` bis `:74`.
- **Auslöser/Folge:** DB-Eintrag und Ordner werden vor Image-Download und Containererstellung angelegt. Scheitert Docker, erhält der Benutzer einen Fehler, aber Datensatz und Port bleiben bestehen. Wiederholen erstellt einen weiteren Eintrag statt den begonnenen Vorgang fortzusetzen.
- **Abnahme:** Fehlerzustand mit wiederaufnehmbarer Erstellung oder vollständige Kompensation; Retry erzeugt keinen überraschenden zweiten Server und keine unnötige Portreservierung.

## Oberfläche und Live-Verbindungen

### BUG-22 — P2 / C — Nach Socket-Reconnect fehlen Serverabonnements

- **Stellen:** `frontend/src/pages/server/ServerLayout.tsx:85`; `frontend/src/pages/server/ConsoleTab.tsx:70`; `frontend/src/lib/socket.ts`.
- **Auslöser/Folge:** Backend-Neustart oder kurze Netzunterbrechung erzeugt einen neuen Socket ohne Räume. `subscribe` wird nur beim Mount/Serverwechsel gesendet; `onConnect` setzt lediglich den grünen Verbindungsstatus. Konsole, Status und Task-Ereignisse bleiben aus.
- **Abnahme:** Aktive Abonnements nach jedem Connect wiederherstellen; mehrfaches Reconnect erzeugt weder doppelte Logs noch Streams. Statusanzeige erst nach erfolgreichem Abo als live markieren.

### BUG-23 — P2 / C — Livezustand bleibt veraltet und kann beim Serverwechsel übernommen werden

- **Stelle:** `frontend/src/pages/server/ServerLayout.tsx:117` und Live-State-Effekt.
- **Auslöser/Folge:** Sobald `liveState` einmal gesetzt wurde, übersteuert er jede frische HTTP-Antwort. Nach Verbindungsverlust bleibt daher z. B. „running“ trotz `server.state=stopped`. Bei direktem Wechsel der Server-ID wird der lokale Zustand ebenfalls nicht zurückgesetzt; bis zum nächsten Socket-Ereignis kann der vorige Serverzustand angezeigt werden.
- **Abnahme:** Livezustand nach Server-ID und Verbindungsfrische verwalten; aktuelle HTTP-Antwort übernimmt bei ausbleibenden Live-Daten. `null`-Stats/Health nicht mit alten Werten ersetzen.

### BUG-24 — P2 / C — Öffentlicher Host ist nach dem Setup praktisch festgeschrieben

- **Stellen:** `backend/src/services/settings.ts`, `getPublicHost`; `backend/src/routes/settings.ts`; `frontend/src/pages/admin/PanelSettings.tsx`.
- **Auslöser/Folge:** Setup speichert `panel.publicHost` in der DB. Dieser Wert gewinnt dauerhaft gegen `PUBLIC_HOST` aus der Umgebung. Die Oberfläche empfiehlt Änderung der `.env`, bietet aber keinen Schreibendpunkt für den DB-Wert; nach Umzug bleiben kopierte Adressen falsch.
- **Abnahme:** Host im Panel ändern/löschen können oder klar geregelte Override-Priorität anbieten. Änderung der tatsächlichen Quelle muss in allen Serveradressen sichtbar werden; bei Proxy-Adressen FEATURE-01 berücksichtigen.

## FEATURE-01 — Minecraft-Proxy für einzelne Server-Subdomains

Vom Nutzer bestätigt: Subdomains für **einzelne Minecraft-Server**, nicht für die Weboberfläche. Beispiel: `survival.example.de` und `mods.example.de` führen zu verschiedenen Servern auf demselben Host. Das ist ein fehlendes Feature, kein weiterer Bug.

**Umgesetzt:** Optionaler separater `itzg/mc-router:1.46.5`-Container, administrierte
Hostnamen/Aliase, schaltbarer Direktzugriff und gemeinsame Portkoordination. Das Panel
schreibt eine Routendatei und lädt sie ausdrücklich per SIGHUP neu. Unbekannte Namen
haben kein Standardziel; der Router bekommt keinen Docker-Socket.
[Einrichtung, Migration und Betriebsgrenzen](docs/MINECRAFT_PROXY.md).

- [x] **PROXY-01 — Datenmodell/API:** Eindeutige normalisierte Hostnamen/Aliase je Server speichern. DNS-Namen validieren, Groß-/Kleinschreibung und abschließenden Punkt normalisieren, Duplikate serverübergreifend atomar verhindern. Änderungen nur durch Admin oder ein ausdrücklich definiertes Proxy-Recht.
- [x] **PROXY-02 — Router-Betrieb:** Optionalen Routerdienst mit festgelegter Version, Netzwerk, Healthcheck und Neustartpolicy integrieren. Zunächst kein automatisches Starten/Stoppen von Minecraft-Servern durch den Router. Für Compose und das Alles-in-einem-/Unraid-Panel einen dokumentierten Begleitcontainer vorsehen.
- [x] **PROXY-03 — Ports/Migration:** 25565/TCP für den Router reservieren. Vorhandenen Minecraft-Server auf 25565 erkennen und kontrolliert migrieren; nie beide Dienste denselben Hostport binden lassen. Direkte Erreichbarkeit pro Server explizit konfigurieren und bestehende Installation nicht unbemerkt unterbrechen.
- [x] **PROXY-04 — Routing-Lebenszyklus:** Hostnamen als Router-Labels oder über kontrollierte Routenkonfiguration ausgeben. Anlegen, Ändern, Löschen, Server-Neuerstellung, Panel-/Router-Neustart müssen konsistent sein. Unbekannte Namen ablehnen statt versehentlich einem anderen Server zuzuordnen.
- [x] **PROXY-05 — Oberfläche:** Subdomain/Alias-Verwaltung, Routerstatus und verständliche Konflikte anzeigen. Primäre Kopieradresse wird die konfigurierte Subdomain ohne Port bei 25565; direkte Adresse zusätzlich kenntlich machen. Konfigurierte Route und tatsächlich erreichbaren Server unterscheiden.
- [x] **PROXY-06 — DNS/Betriebsanleitung:** A-/gegebenenfalls AAAA-Einträge der Subdomains auf den Routerhost zeigen lassen, TCP-Portfreigabe erklären und echte Domainwerte vom Betreiber einsetzen lassen. DNS-Eintrag, Routerroute und Serverstatus getrennt diagnostizieren. Zusatzports für Mods sind separat zu behandeln.
- [ ] **PROXY-07 — Vollständige Betriebsabnahme noch offen:** Zwei gleichzeitige Minecraft-Backends über zwei Subdomains auf demselben öffentlichen Port; Serverlisten-Ping und Login landen jeweils richtig. Zusätzlich Alias, ungültiger/duplizierter/unbekannter Hostname, offline Backend, Umbenennung, Löschung, Neustart und Migration eines bestehenden 25565-Servers testen. Mindestens Vanilla/Paper und ein tatsächlich eingesetztes Fabric-/Forge-/NeoForge-Pack prüfen.

## Nächster Schritt

Betriebsabnahme in einer Docker-Testumgebung nach `docs/MINECRAFT_PROXY.md`, insbesondere
PROXY-07 und die oben ausdrücklich offenen Tests. Erst danach produktiv aktualisieren.
Die Serversperren koordinieren einen Backend-Prozess; mehrere aktive Panel-Instanzen
gegen denselben Datenordner sind nicht unterstützt. Kontingente begrenzen Panel-Schreibvorgänge,
aber keine Schreibzugriffe eines laufenden Minecraft-Prozesses und keinen temporären
Mehrbedarf beim transaktionalen Staging. Symlinks im Dateimanager werden bewusst abgewiesen.

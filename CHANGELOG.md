# Änderungsprotokoll

Alle nennenswerten Änderungen am Panel. Neue Fassungen entstehen über einen
Git-Tag `vX.Y.Z`; daraus baut die CI das Abbild `ghcr.io/…:X.Y.Z` (und
`:X.Y`). `latest` folgt weiterhin dem Hauptzweig.

Die Oberfläche zeigt dieses Protokoll unter **Einstellungen → Was ist neu**.
Neue Einträge kommen immer oben in einen Abschnitt „[Unveröffentlicht]“; beim
Taggen wird daraus eine Versionsüberschrift.

## [Unveröffentlicht]

### Neu
- **Karte und Vorgenerierung**: Neuer Reiter „Karte“ mit Live-Spielerpositionen und einer Übersicht aller generierten Chunks (direkt aus den Weltdateien, ohne Mod). Mit BlueMap zusätzlich das Gelände – eingebettet über das Panel, ohne offenen Port. Die Welt lässt sich über die Oberfläche mit Chunky vorgenerieren: Bereich per Klick auf die Karte, Fortschritt, Tempo und Restzeit live, automatische Pause bei Spielern oder niedrigen TPS, Fortsetzen nach Neustart. Chunky und BlueMap installiert das Panel passend zu Loader und Version von Modrinth. Neues Recht „Welt vorgenerieren“. Details in `docs/KARTE.md`.
- **Zusatzports und UniFi-Portfreigaben**: Simple Voice Chat, Geyser, BlueMap, Dynmap, squaremap und Votifier werden vor jedem Start erkannt, bekommen einen freien Port und werden im Container freigegeben – auch wenn mehrere Server dieselbe Erweiterung nutzen. Mit einer angebundenen UniFi-Konsole (UDM Pro & Co., per API-Schlüssel oder lokalem Benutzer) legt das Panel die Portweiterleitungen im Router selbst an und räumt sie wieder ab. Übersicht je Server unter *Einstellungen → Zusätzliche Ports*, Details in `docs/UNIFI.md`.
- **Nodes: Minecraft-Server auf weiteren Rechnern**: Ein gemieteter VPS oder ein zweiter PC im Heimnetz lässt sich unter **Nodes** per Assistent anbinden. Ein einziger Befehl auf der Node installiert bei Bedarf Docker und den Node-Agenten und verbindet ihn mit dem Panel. Rechner im Internet laufen über einen WireGuard-Tunnel, für den der Hauptserver keinen offenen Port braucht. Rechner im selben Netz lassen sich per Schalter ohne VPN anbinden. Auch Windows-PCs mit Docker Desktop können Node sein – dafür gibt es den Installationsbefehl für die PowerShell. Die Nodes-Seite zeigt je Rechner CPU-Last, belegten und zugewiesenen RAM sowie freien Platz. Neue Server landen auf Wunsch automatisch auf der Node mit dem meisten freien Speicher, bestehende ziehen per Klick um (Einstellungen → Node) – als Live-Umzug: kopiert wird im laufenden Betrieb, offline ist der Server nur für den letzten Abgleich der geänderten Dateien. Konsole, Dateimanager, Backups und Modpacks funktionieren auf Nodes wie gewohnt. Details in `docs/NODES.md`.
- **KI-Assistent mit Anthropic (Claude)**: Neben OpenAI-kompatiblen Diensten lässt sich Claude jetzt direkt über die Anthropic-API anbinden – nur API-Key und Modell eintragen (Vorgabe `claude-opus-5-5`). Beim Speichern werden Key und Modell geprüft, ohne Kosten zu verursachen; Nachfragen im selben Dialog nutzen Prompt-Caching. Die Anbindung lässt sich jetzt auch per Knopf entfernen.

### Geändert
- **Arbeitsspeicher nur durch Administratoren**: Besitzer und Mitglieder können den Java-Heap nicht mehr ändern – weder in den Einstellungen noch bei Neuinstallation, ZIP-Import oder über den Assistenten. Das Kontingentfeld „Max. Java-Heap“ entfällt.
- **Neuinstallation leichter zu finden**: Die Reiterleiste bricht um, statt hintere Reiter unsichtbar abzuschneiden; zusätzlich führt ein Knopf in den Einstellungen dorthin.
- **Bestätigungsdialoge** zeigen den einzutippenden Namen in Originalschreibweise – vorher erschien er in Großbuchstaben und ließ sich so nicht bestätigen.
- **Backups deutlich schneller**: Neue Sicherungen sind ZIP-Archive. Bereits komprimierte Dateien wie Regionsdateien und Mods werden unverändert abgelegt statt ein zweites Mal gepackt; in einer Messung mit 400 MB Weltdaten sank die Zeit von etwa 10 s auf 0,5 s bei gleicher Größe. Ältere tar.gz-Sicherungen bleiben prüf- und einspielbar.
- **Fortschritt in Prozent** beim Erstellen, Prüfen und Einspielen eines Backups.
- **Welt-Download mit Fortschrittsbalken**: Die Welt wird als Aufgabe gepackt („Welt wird gepackt … 43 %“), der Download startet danach von selbst. Heruntergeladen wird jetzt ein ZIP, das jedes Betriebssystem ohne Zusatzprogramm öffnet und das sich direkt wieder hochladen lässt.

## [1.0.0] – 2026-10-16

### Neu
- **Wiederherstellungscodes für die Zwei-Faktor-Anmeldung**: Beim Einrichten gibt es zehn Einmalcodes, mit denen man sich ohne Authenticator-App anmelden kann. Sie lassen sich im Profil jederzeit neu erzeugen.
- **Zwei-Faktor-Pflicht** als Admin-Einstellung: aus, nur für Administratoren oder für alle Konten. Betroffene Konten werden nach der Anmeldung direkt zur Einrichtung geführt.
- **Angemeldete Geräte** im Profil: Liste aller Sitzungen mit Gerät, Adresse und letzter Aktivität; jedes Gerät lässt sich einzeln abmelden. „Abmelden“ beendet jetzt wirklich die Sitzung auf dem Server.
- **Backup-Prüfung**: Jedes neue Backup wird direkt nach dem Packen vollständig gelesen; bestehende Backups lassen sich per Knopf prüfen. Die Liste zeigt, wann ein Backup zuletzt geprüft wurde und mit welchem Ergebnis. Fehlschläge lösen eine Benachrichtigung aus.
- **Weltverwaltung** als eigener Reiter: Welten auflisten, zwischen Welten wechseln, neue Welt mit Seed anlegen, aktive Welt mit neuem Seed zurücksetzen (immer mit Sicherheits-Backup), Welten als Archiv herunterladen und als ZIP hochladen.
- **Spielerstatistik**: Verlauf der Spielerzahl und Spielzeit je Spieler über 1 bis 90 Tage – unabhängig davon, ob gerade jemand das Panel geöffnet hat.
- **Speicherplatz** des Datenträgers in den Panel-Einstellungen, mit Warnung bei knappem Platz (die Benachrichtigung bei vollem Datenträger gab es schon).
- **Was ist neu**: dieses Änderungsprotokoll in der Oberfläche.

### Intern
- Versionierte Abbilder über Git-Tags; vor dem Veröffentlichen läuft ein End-zu-End-Test gegen das frisch gebaute Abbild.

## Stand 2026-10-15 (vor der Versionierung)

Bis hierhin gab es keine Versionsnummern. Die wichtigsten Meilensteine:

- **2026-10-15** – Sicherheits- und Zuverlässigkeitsrunde: optionale Zwei-Faktor-Anmeldung (TOTP), Download-Links mit Kurzzeit-Token, Einrichtungscode für den Assistenten, Upload-Kontingente, Serversperre für Uploads und SFTP.
- **2026-10-13/14** – Bestehende Server als ZIP importieren, Neuinstallation mit eigenem Recht, Erkennung offizieller FTB-, Forge- und Pixelmon-Serverpakete, Rechteverwaltung nur durch Administratoren.
- **2026-10-12** – SFTP-Zugriff mit Panel-Anmeldung, TPS-Messung ohne Mods, Statuswarnungen, Testkopien, Update-Vorschau, Panel-Sicherungen.
- **2026-09** – KI-Assistent für Absturzprotokolle, Proxy-Übersicht, bekannte Spieler, RCON-Wiederverwendung, Container mit Panelnamen und Icons, Subdomain-Proxy.
- **2026-08** – Erste Fassung: Modpack-Installer für Modrinth und CurseForge, Mehrbenutzerbetrieb, Backups mit Zweitablage, Automationen, Plugin-Verwaltung, Einrichtungsassistent, Alles-in-einem-Abbild für Unraid.

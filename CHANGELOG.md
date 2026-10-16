# Änderungsprotokoll

Alle nennenswerten Änderungen am Panel. Neue Fassungen entstehen über einen
Git-Tag `vX.Y.Z`; daraus baut die CI das Abbild `ghcr.io/…:X.Y.Z` (und
`:X.Y`). `latest` folgt weiterhin dem Hauptzweig.

Die Oberfläche zeigt dieses Protokoll unter **Einstellungen → Was ist neu**.
Neue Einträge kommen immer oben in einen Abschnitt „[Unveröffentlicht]“; beim
Taggen wird daraus eine Versionsüberschrift.

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

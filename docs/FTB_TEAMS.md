# FTB-Teams-Partys verwalten

Läuft auf einem Server der Mod **FTB Teams**, zeigt der Reiter **Spieler** den
Abschnitt **FTB-Partys**: alle Partys mit Mitgliedern, Rängen, Einladungen und
Verbündeten – und die Verwaltung, ohne dafür ins Spiel zu müssen.

## Was geht

| Aktion | Befehl, den das Panel schickt | Hinweis |
|---|---|---|
| Spieler hinzufügen | `ftbteams force-add <party> <spieler>` | Spieler darf in keiner Party sein; ab FTB Teams für 1.21 |
| Spieler entfernen | `ftbteams force-remove <party> <spieler>` | nicht für den Besitzer; ab 1.21 |
| Besitzer wechseln | `ftbteams party transfer_ownership_for <party> <spieler>` | neuer Besitzer muss Mitglied sein |
| Umbenennen | `ftbteams party settings_for <party> ftbteams:display_name <name>` | |
| Auflösen | `ftbteams force-disband <party>` | mit Rückfrage; nicht umkehrbar |
| Neue Party | `execute as <spieler> run ftbteams party create <name>` | Spieler muss online und in keiner Party sein – der Mod kennt dafür keinen Admin-Befehl |

Kennt eine ältere Fassung des Mods einen Befehl nicht, zeigt das Panel dessen
Antwort als Fehler an.

## Wie es funktioniert

- **Lesen**: aus den Dateien des Mods im Weltordner
  (`<welt>/ftbteams/party/*.snbt`, `…/player/*.snbt`). Das geht auch bei
  gestopptem Server. Der Mod schreibt die Dateien beim Speichern der Welt – nach
  einer Änderung stößt das Panel deshalb ein `save-all` an und liest kurz darauf
  neu.
- **Ändern**: ausschließlich über die Befehle des Mods, damit der laufende Server
  und die Spieler die Änderung sofort mitbekommen. Der Server muss dafür laufen;
  die Dateien selbst fasst das Panel nie an.
- **Rechte**: Ansehen mit „Konsole lesen“, Ändern mit „Befehle senden“ – dieselben
  Befehle ließen sich sonst von Hand in der Konsole eingeben. Administratoren und
  Besitzer haben beides.

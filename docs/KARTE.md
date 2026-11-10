# Karte und Vorgenerierung

Reiter **Karte** je Server: eine Live-Karte mit Spielern und die Vorgenerierung
der Welt über die Weboberfläche.

## Was die Karte zeigt

| Ebene | Quelle | Voraussetzung |
|---|---|---|
| **Chunk-Status** | Kopf der Regionsdateien (`r.x.z.mca`) – jeder gespeicherte Chunk | keine Mod, jede Version, auch bei gestopptem Server |
| **Gelände** | BlueMap, eingebettet über das Panel | BlueMap installiert, Server läuft |
| **Spieler** | RCON `data get entity <Name> Pos` bzw. `Dimension`, alle 2 s | Minecraft ab 1.13 |

Die BlueMap-Karte läuft **nur über das Panel** (`/api/map-view/<token>/…`): ohne
veröffentlichten Port und ohne Router-Freigabe. Auf dem Hauptserver erreicht das
Panel BlueMap über das Minecraft-Netz, auf Nodes über den dort (ohne
Router-Freigabe) veröffentlichten Port.

Sicherheit: Was BlueMap ausliefert, liegt im Serverordner und könnte von jedem mit
Dateirechten verändert werden. Deshalb läuft die eingebettete Seite in einer
Sandbox (CSP `sandbox` ohne `allow-same-origin`) und hat keinen Zugriff auf
Anmeldung oder Speicher des Panels. Der Link ist ein eigenes Kurzzeit-Token
(12 h, an Server, Benutzer und `sessionVersion` gebunden), kein Sitzungs-JWT.

## Vorgenerierung mit Chunky

Das Panel steuert [Chunky](https://modrinth.com/plugin/chunky) ausschließlich über
Konsolenbefehle und liest den Fortschritt mit `chunky progress`:

- Dimension, Form (Kreis/Quadrat), Mittelpunkt (auch per Klick auf die Karte) und
  Radius wählen; die Schätzung zeigt Chunks, Speicherbedarf (~10 KiB/Chunk) und
  Dauer. Was nicht ins Speicherkontingent passt, startet nicht.
- **Nur ohne Spieler**: pausiert, solange jemand online ist.
- **Bei Last bremsen**: pausiert unter 15 TPS, macht ab 18 TPS weiter.
- **Karte erst danach rendern**: `bluemap stop` während der Generierung,
  `bluemap start` danach.
- Nach einem Neustart des Servers setzt das Panel den Auftrag selbst fort (Chunky
  tut das standardmäßig nicht).

Recht: **Welt vorgenerieren** (`world.pregen`) – Administratoren und Besitzer haben
es automatisch, Mitglieder nur, wenn es vergeben wird. Die Karte sieht jeder mit
„Konsole lesen“.

## Erweiterungen

Chunky und BlueMap installiert das Panel auf Knopfdruck von Modrinth – passend zu
Loader und Minecraft-Version (Stand der Modrinth-Daten):

| Server | Chunky | BlueMap |
|---|---|---|
| NeoForge | ab 1.20.2 | ab 1.20.2 |
| Forge | ab 1.16.5 | ab 1.14.4 |
| Fabric | ab 1.16 | ab 1.15.2 |
| Paper/Purpur/Spigot | ja | ja |
| Vanilla | – | – |

Ältere Forge-Versionen bekommen bewusst keinen Ersatz (Chunk Pregenerator wäre nur
über CurseForge, nicht quelloffen und mit Zusatz-Mod) – die Chunk-Status-Karte und
die Spieler funktionieren dort trotzdem.

BlueMap zeichnet erst, wenn sie Spielgrafiken von Mojang laden darf
(`accept-download: true` in `core.conf`). Die Zustimmung gibt man in der
Oberfläche; das Panel trägt sie ein, sobald BlueMap die Datei angelegt hat, und
lädt BlueMap neu.

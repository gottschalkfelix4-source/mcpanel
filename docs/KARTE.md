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

In dieser Sandbox wirft der Browser schon beim Zugriff auf `localStorage` einen
`SecurityError`. BlueMap fängt das nicht ab und meldet dann irreführend „Failed
to load BlueMap webapp! Make sure you have WebGL2 enabled“. Das Panel setzt
deshalb in jede HTML-Seite der Karte als erstes ein kleines Skript, das einen
werfenden Speicher durch einen im Arbeitsspeicher ersetzt (`STORAGE_SHIM` in
`services/bluemapProxy.ts`). Kartenauswahl, Kamera und eingeblendete
Markierungen gelten damit bis zum Neuladen des Reiters.

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

## Weltgröße

Das Panel „Weltgröße“ zählt alle Weltordner (`<level-name>`, bei Paper & Co.
auch `<level-name>_nether` und `<level-name>_the_end`) samt Unterordnern. Unter
der Karte steht zusätzlich, wie viel Platz die Regionsdateien der angezeigten
Dimension belegen.

## Chunks zurücksetzen

Entfernt Chunks aus den Regionsdateien; Minecraft erzeugt sie beim nächsten
Betreten neu.

- **Alles außerhalb**: Nur der gewählte Kreis bzw. das Quadrat bleibt – die Welt
  wird auf einen Umkreis zurückgestutzt.
- **Nur den Bereich**: Genau dieses Gebiet wird neu generiert, etwa nach einem
  Mod-Update für neue Biome oder Erze.

Maßgeblich ist die Mitte eines Chunks, wie bei Chunky. Die Karte zeigt rot, was
wegfällt; die Vorschau rechnet Chunks und frei werdenden Platz aus den
Tabellen der Regionsdateien aus.

- Läuft nur bei **gestopptem Server** (er hält die Regionsdateien offen) und
  nicht, solange für dieselbe Dimension eine Vorgenerierung läuft.
- Vorgabe: vorher ein **Backup** (abwählbar). Gebraucht werden die Rechte
  „Welt vorgenerieren“ und „Dateien bearbeiten“, für das Backup zusätzlich
  „Backups erstellen“.
- `region/`, `entities/` und `poi/` werden gemeinsam gekürzt, ausgelagerte
  Riesen-Chunks (`c.<x>.<z>.mcc`) mitgelöscht. Teilweise betroffene Dateien
  werden lückenlos neu geschrieben (Zwischendatei + rename), leere gelöscht.
- Eine beschädigte Regionsdatei bleibt unverändert und wird im Protokoll
  genannt.

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

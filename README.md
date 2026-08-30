# MCPanel

Selbstgehostetes Web-Panel für Minecraft-Server – mit Modpack-Installer und -Updater
für **Modrinth** und **CurseForge**, mehreren Benutzern und fein einstellbaren Rechten.
Jeder Minecraft-Server läuft als eigener Docker-Container (`itzg/minecraft-server`),
das Panel steuert sie über den Docker-Socket.

```
┌──────────┐   HTTP/WebSocket   ┌──────────┐   Docker API   ┌──────────────────┐
│ Frontend │ ─────────────────► │ Backend  │ ─────────────► │ mc-<id> Container│
│ React    │                    │ Fastify  │                │ mc-<id> Container│
│ nginx    │                    │ Prisma   │   RCON/Logs    │ …                │
└──────────┘                    └────┬─────┘ ◄───────────── └──────────────────┘
                                     │
                                ┌────▼─────┐
                                │ Postgres │
                                └──────────┘
```

---

## Funktionen

**Ersteinrichtung**
- Beim ersten Aufruf führt ein Assistent durch Konto, Server-Adresse und Modpack-Quellen
- Vorher prüft er, ob der Docker-Socket erreichbar ist – sonst fällt das erst beim ersten
  Serverstart auf
- Die Einrichtungsroute ist hart daran gebunden, dass noch kein Konto existiert; danach
  antwortet sie mit 403

**Server**
- Anlegen von Vanilla-, Paper-, Purpur-, Spigot-, Fabric-, Forge-, NeoForge- und Quilt-Servern
- Start / Stop / Neustart / Kill, Autostart beim Panel-Start
- Automatische Port-Vergabe aus einem konfigurierbaren Bereich
- Live-Werte für CPU, RAM, Speicherplatz und Spielerzahl

**Dashboard mit Tabs** (Klick auf einen Server)
| Tab | Inhalt |
|---|---|
| Übersicht | Kennzahlen, Serverdetails, Modpack, letzte Aktionen, Spielerliste |
| Konsole | Live-Log über WebSocket, farbig, Befehlseingabe mit Verlauf (↑), Filter, Log-Download |
| Modpack | Installiertes Pack, Update-Prüfung, Versionswechsel, Modpack-Suche |
| Mods | Inhalt von `mods/`, einzeln aktivieren/deaktivieren/löschen, einzelne Mods nachinstallieren |
| Dateien | Dateimanager mit Editor, Upload, Download, Umbenennen, ZIP entpacken |
| Konfiguration | `server.properties` als gruppiertes Formular + Rohwerte |
| Backups | tar.gz-Sicherungen erstellen, herunterladen, einspielen, löschen, optional mit Zweitkopie |
| Spieler | Online-Liste, Whitelist, Operatoren, Bans – Aktionen laufen über RCON |
| Automation | Zeitgesteuerte Regeln (Befehle, Backups, Neustarts, Modpack-Updates) und Benachrichtigungskanäle |
| Zugriff | Mitglieder einladen und Rechte einzeln vergeben |
| Einstellungen | Name, RAM, Version, Umgebungsvariablen, Kontingent, Server löschen |

**Modpacks**
- Suche über Modrinth und CurseForge (gemeinsam oder einzeln), Filter nach MC-Version und Sortierung
- Installer für `.mrpack` (Modrinth) und `manifest.json`-Archive (CurseForge), inkl. Serverpaketen ohne Manifest
- **Serverpakete haben immer Vorrang** – siehe [Client- und Serverpakete](#client--und-serverpakete)
- Loader (Forge / NeoForge / Fabric / Quilt) und Minecraft-Version werden automatisch gesetzt
- Updater mit Versionsvergleich, automatischem Backup und optionalem Schutz für eigene `config/`-Änderungen
- Welt, `server.properties`, Whitelist, OP- und Bannlisten bleiben bei Updates immer erhalten
- Live-Fortschritt mit Protokoll im Panel

**Automatisierungen** (pro Server)
- Auslöser: Zeitplan (Cron, 5 Felder) oder „Nach Absturz“ (Container unerwartet beendet)
- Aktionen: Befehl senden, Backup erstellen, Neustart, Starten, Stoppen, Modpack-Update
- Cron-Vorschau in Klartext plus nächster Ausführungszeit, dazu Vorlagen (stündlich, nächtlich, wöchentlich)
- Optional „nur wenn der Server läuft“, Backup-Regeln können alte Sicherungen automatisch aufräumen
- Regeln lassen sich jederzeit von Hand auslösen; letzter Status und Laufzähler stehen in der Liste
- Der Scheduler prüft alle 20 Sekunden; Zeitzone über `TZ` (Vorgabe `Europe/Berlin`)

**Backups**
- tar.gz je Server; Welt, Mods und Konfiguration, ohne `cache/`, `logs/`, `libraries/`
- Vor jedem Modpack-Update wird automatisch eines angelegt
- **Zweitablage**, eingerichtet in den Panel-Einstellungen (nicht in der `.env`):
  - **Samba-Freigabe** – NAS oder Windows-Rechner im Netz; das Panel hängt die Freigabe selbst ein
  - **S3-Speicher** – AWS S3, MinIO, Backblaze B2, Wasabi; Upload mehrteilig, also auch über 5 GB
  - Jede fertige Sicherung wird dorthin kopiert und in der Liste als *2. Ablage* gekennzeichnet.
    Fehlt die Hauptdatei, holen Download und Wiederherstellung sie von dort zurück.
  - Zugangsdaten liegen in der Datenbank und werden nie an die Oberfläche zurückgegeben;
    ein leer gelassenes Kennwortfeld bedeutet „unverändert lassen“.
  - Gespeichert wird nur, was sich vorher verbinden ließ – sonst würde ab da jede
    nächtliche Sicherung still scheitern.
  - Ohne Zweitablage liegen Sicherungen neben den Serverdaten auf derselben Platte –
    das überlebt keinen Plattenausfall.

**Benachrichtigungen**
- Ziele: **Discord-Webhook** oder beliebiger HTTP-Endpunkt, der JSON annimmt (ntfy, Gotify, eigenes Skript)
- Kanäle gelten je Server (Tab *Automation*) oder für alle Server (Panel-Einstellungen)
- Ereignisse einzeln abonnierbar: Server gestartet / gestoppt / **abgestürzt**, Automatisierung
  gelungen / fehlgeschlagen, Backup erstellt / fehlgeschlagen, Modpack-Update verfügbar, Speicherplatz knapp
- Bei einem Absturz hängen die letzten Protokollzeilen mit in der Nachricht
- Testknopf je Kanal; die gespeicherte URL wird nie zurückgegeben, in der Liste steht sie gekürzt

**Kontingent je Server**
- Grenzen hängen am Server, nicht am Konto: Speicherplatz (Daten + Sicherungen), Zahl der
  aufbewahrten Sicherungen und der höchste Java-Heap, den Mitglieder ohne Adminrechte setzen dürfen
- Gesetzt werden sie nur von Administratoren – im Tab *Einstellungen* oder beim Anlegen
- Ist der Platz aufgebraucht, lehnt das Panel neue Sicherungen und Uploads sofort ab und nennt
  belegte wie erlaubte Größe; ab 90 % geht das Ereignis *Speicherplatz knapp* raus
- Überzählige Sicherungen werden nach jedem Backup automatisch entfernt (älteste zuerst)
- **Server anlegen ist Administratorensache.** Freunde bekommen über den Tab *Zugriff* Rechte
  auf einen bestehenden Server, statt sich selbst welche einzurichten – an einem Server hängen
  Arbeitsspeicher, Plattenplatz und ein Port.

**Mehrbenutzerbetrieb**
- Rollen: Administrator und Benutzer
- Pro Server: Besitzer + eingeladene Mitglieder
- 13 einzeln vergebbare Rechte, z. B. „Konsole lesen“, „Befehle senden“, „Starten / Stoppen“,
  „Dateien bearbeiten“, „Backups einspielen“, „Modpacks verwalten“, „Automatisierungen verwalten“, „Mitglieder verwalten“
- Aktivitätsprotokoll für Administratoren

---

## Schnellstart

Voraussetzung: Docker mit Compose-Plugin. Sonst nichts.

```bash
docker compose up -d
```

Dann **http://localhost:8080** öffnen – ein Assistent fragt nach Konto, Server-Adresse
und optional dem CurseForge-Schlüssel. Es ist keine `.env` nötig: das Sitzungs-Geheimnis
erzeugt das Panel beim ersten Start selbst und legt es unter `data/.jwt-secret` ab.

### Wenn es woanders liegen soll

Für einen echten Server gehören die Daten meist nicht neben das Projekt. Dafür reicht eine
`.env` mit einer einzigen Zeile:

```bash
echo "HOST_DATA_ROOT=/srv/mcpanel" > .env
docker compose up -d
```

`.env.example` listet alles Weitere – Port des Panels, Port-Bereich der Server, Zeitzone.
Nichts davon ist Pflicht.

> `HOST_DATA_ROOT` muss ein **absoluter** Pfad sein. Das Panel reicht ihn beim Anlegen
> eines Servers als Bind-Mount an den Docker-Daemon weiter – ein relativer Pfad würde
> dort ins Leere zeigen. Bleibt die Variable leer, liest das Panel den Host-Pfad aus den
> eigenen Mounts aus.

### Ohne Assistent einrichten

Wer das Panel unbeaufsichtigt ausrollt, setzt `ADMIN_USERNAME`, `ADMIN_EMAIL` und
`ADMIN_PASSWORD` in der `.env`. Dann wird das Konto direkt beim ersten Start angelegt und
der Assistent übersprungen.

---

## Unraid

Im Ordner [`unraid/`](unraid/mcpanel.xml) liegt eine Template-Datei. In Unraid unter
*Docker → Add Container → Template* die URL eintragen:

```
https://raw.githubusercontent.com/gottschalkfelix4-source/mcpanel/main/unraid/mcpanel.xml
```

Unraid startet je Anwendung genau einen Container, deshalb gibt es dafür ein eigenes
Abbild, das PostgreSQL, Backend und Oberfläche zusammenfasst
([`Dockerfile`](Dockerfile) im Wurzelverzeichnis). Der Compose-Stack bleibt die Variante
für alle, die die Dienste getrennt betreiben wollen.

Einzustellen sind nur drei Dinge:

| Feld | Wert |
|---|---|
| Weboberfläche | Port, Vorgabe `8080` |
| Daten | z. B. `/mnt/user/appdata/mcpanel` – Serverdaten, Backups und Datenbank |
| Docker-Socket | `/var/run/docker.sock` |

Den Host-Pfad der Daten liest das Panel selbst aus seinen Mounts aus; er ist also nicht
doppelt einzutragen. Alles Weitere fragt der Assistent beim ersten Aufruf.

### Updates

Unraid zeigt neue Fassungen von selbst an: sobald der Workflow ein neues `:latest`
veröffentlicht hat, steht auf der Docker-Seite *update ready*, und ein Klick auf
**Apply Update** zieht das Abbild und setzt den Container neu auf. Daten, Welten und
Datenbank liegen im `/data`-Volume und bleiben davon unberührt; das Schema wird beim
Start automatisch abgeglichen.

Welcher Stand gerade läuft, steht im Panel unter *Einstellungen → Systemkonfiguration*
als **Panel-Fassung** (Kurz-Commit und Baudatum).

Zwei Dinge machen das überhaupt erst zuverlässig:

- Das Abbild wird **ohne Attestierungen** veröffentlicht (`provenance: false`,
  `sbom: false`). Sonst legt buildx neben das Abbild ein zweites Manifest
  `unknown/unknown`, und Unraids Digest-Vergleich meldet dauerhaft *update ready*,
  ohne dass sich etwas geändert hätte.
- Das Manifest liegt in **Docker-Medientypen** (`oci-mediatypes=false`). In den
  OCI-Typen antwortet die Registry nur Clients, die diese ausdrücklich im
  `Accept`-Kopf mitschicken – Docker tut das, Unraids Update-Prüfung fragt nur nach
  den Docker-Typen und bekommt sonst 404. In der Oberfläche steht dann
  *Update-Status: nicht verfügbar*.
- Die PostgreSQL-Hauptversion ist im Abbild festgenagelt. Würde ein Update sie
  wechseln, käme das alte Datenverzeichnis nicht mehr hoch – das Startskript prüft
  das und bricht mit einer verständlichen Meldung ab, statt mit
  „database files are incompatible“ stehenzubleiben.

Wer nicht jeden Push mitnehmen will, trägt im Template statt `latest` eine feste
Fassung ein – Git-Tags der Form `v1.2.3` erzeugen zusätzlich `:1.2.3` und `:1.2`.

Dasselbe Abbild lässt sich auch ohne Unraid einzeln starten:

```bash
docker run -d --name mcpanel -p 8080:8080   -v /var/run/docker.sock:/var/run/docker.sock   -v /srv/mcpanel:/data   ghcr.io/gottschalkfelix4-source/mcpanel:latest
```

> Der Docker-Socket gibt dem Container root-gleiche Rechte auf dem Host. Ohne ihn kann
> das Panel keine Minecraft-Server starten – wer das nicht möchte, sollte MCPanel nicht
> betreiben.

---

## Konfiguration

Alle Werte kommen aus der `.env` (siehe `.env.example`):

| Variable | Standard | Zweck |
|---|---|---|
| `PANEL_PORT` | `8080` | Port des Web-Panels |
| `HOST_DATA_ROOT` | `./data` | Host-Pfad der Serverdaten |
| `MC_PORT_MIN` / `MC_PORT_MAX` | `25565` / `25700` | Port-Bereich für neue Server |
| `PUBLIC_HOST` | `localhost` | Angezeigte Serveradresse |
| `JWT_SECRET` | – | Secret für Sitzungstokens |
| `CURSEFORGE_API_KEY` | leer | CurseForge-Zugang (auch im Panel unter *Panel → CurseForge* setzbar) |
| `MC_IMAGE` | `itzg/minecraft-server:latest` | Image für die Serverkontainer |
| `POSTGRES_*` | `mcpanel` | Datenbankzugang |

Der CurseForge-Key lässt sich im laufenden Betrieb unter **Panel → Panel-Einstellungen**
eintragen; er wird dort direkt gegen die API geprüft und in der Datenbank abgelegt
(hat Vorrang vor der `.env`).

### Client- und Serverpakete

Ein CurseForge-Modpack ist zunächst ein **Client**-Paket: seine `manifest.json`
listet auch reine Client-Mods wie Sodium, Iris oder OptiFine. Auf einem dedizierten
Server stürzen die beim Start ab, weil sie OpenGL/LWJGL erwarten
(`ClassNotFoundException: org.lwjgl.Version`).

Der Installer geht deshalb in dieser Reihenfolge vor:

1. **Serverpaket des Autors**, wenn CurseForge eines verknüpft hat (`serverPackFileId`).
2. **Serverpaket über die Versionskennung**, wenn der Autor eines hochgeladen, aber
   nicht verknüpft hat. Zugeordnet wird nur bei übereinstimmender Versionsnummer
   *und* passender Minecraft-Version.
3. **Client-Paket**, wenn es kein Serverpaket gibt. Ob danach gefiltert wird,
   hängt vom Loader ab (siehe unten).

Welcher Weg genommen wurde, steht im Installationsprotokoll des Tasks. In der
Versionsauswahl zeigt ein Abzeichen „Serverpaket" bzw. „nur Client-Paket", was
dich erwartet.

#### Wer sortiert die Client-Mods aus

| Quelle / Loader | Vorgehen |
|---|---|
| Modrinth (`.mrpack`) | Das Archiv markiert pro Datei, ob sie serverseitig läuft (`env.server`). Der Installer lädt Client-Only-Dateien gar nicht erst herunter und wertet `server-overrides/` aus. |
| CurseForge + **Fabric/Quilt** | Mods mit `"environment": "client"` bleiben **unangetastet** — der Loader überspringt sie selbst, und die Jars werden noch für die Abhängigkeitsauflösung anderer Mods gebraucht. Deaktiviert wird nur, was faktisch clientseitig ist, das aber nicht angibt (siehe unten). |
| CurseForge + **Forge/NeoForge** | Es gibt keine standardisierte Seiten-Angabe. Deshalb greift eine kurze Liste bekannter Renderer (Sodium, Iris, Oculus, Rubidium, Embeddium, OptiFine …), die serverseitig auf LWJGL zugreifen und den Start abbrechen. |

**Fabric/Quilt – falsch deklarierte Client-Mods.** Der Loader erkennt nicht, dass
eine als beidseitig deklarierte Mod nur wegen einer Client-Mod existiert. Sie
startet dann mit `Cannot load class … in environment type SERVER`. Zwei Regeln,
beide transitiv angewandt, fangen das ab:

1. Pflicht-Abhängigkeit (`depends`) auf eine Client-Mod → selbst clientseitig.
2. Mod-ID beginnt mit `<client-mod-id>_` oder `-` → Begleit-Mod desselben Projekts.

Gemessen an einem Pack mit 368 Mods traf das genau die zwei Dateien, die den Start
verhinderten (`colorwheel` über Regel 1, `colorwheel_patcher` über Regel 2) — keine
Fehltreffer.

**Forge/NeoForge – Abhängigkeitsschutz.** Vor dem Deaktivieren wird
`META-INF/mods.toml` bzw. `neoforge.mods.toml` aller Mods gelesen: Deklariert eine
bleibende Mod eine Abhängigkeit auf einen Kandidaten, bleibt dieser aktiv. Ihn zu
entfernen würde den Server genauso am Start hindern — nur mit einer anderen
Fehlermeldung.

Deaktivierte Mods werden **nicht gelöscht**, sondern in `.jar.disabled` umbenannt —
im Tab *Mods* lässt sich jede mit einem Klick wieder einschalten.

### Verzeichnisstruktur der Daten

```
$HOST_DATA_ROOT/
├── servers/<serverId>/     # /data des jeweiligen Minecraft-Containers
├── backups/<serverId>/     # backup-<zeitstempel>.tar.gz
└── cache/modpacks/         # heruntergeladene Modpack-Archive
```

---

## Entwicklung

```bash
# Datenbank aus dem Stack nutzen
docker compose up -d db

# Backend
cd backend
npm install
npx prisma generate
DATABASE_URL=postgresql://mcpanel:mcpanel@localhost:5432/mcpanel \
JWT_SECRET=dev DATA_ROOT=./data HOST_DATA_ROOT=$(pwd)/data \
npm run dev

# Frontend (proxyt /api und /socket.io auf Port 3000)
cd frontend
npm install
npm run dev
```

Für den Datenbankzugriff von außen den Port in `docker-compose.yml` bei `db` freigeben.

Schema-Änderungen: `prisma/schema.prisma` bearbeiten, dann `npx prisma db push`.
Der Container macht das beim Start automatisch.

---

## App auf dem Handy (PWA)

Das Panel ist eine installierbare Web-App: Manifest, Icons und ein Service Worker
sind eingebaut, das Layout skaliert bis auf Handybreite herunter (Tabs scrollen
horizontal, Tabellen blenden Nebenspalten aus, Touch-Ziele sind groß genug).

**Installieren:** Panel im mobilen Browser öffnen → Menü → *„Zum Startbildschirm
hinzufügen"* / *„App installieren"*. Die App startet dann ohne Browserleisten
(Standalone) mit dem Grasblock-Icon.

**Wichtig fürs Handy:**

1. `PUBLIC_HOST` in der `.env` auf die LAN-IP oder den Hostnamen des Servers
   setzen (z. B. `192.168.1.50`), sonst zeigt das Panel `localhost`-Adressen an,
   mit denen das Handy nichts anfangen kann. Aufrufen dann über
   `http://<diese-IP>:8080`.
2. Der **Service Worker** (Offline-Hülle, echter Install-Prompt in Chrome) läuft
   aus Browser-Sicherheitsgründen nur über **HTTPS** oder `localhost`. Über eine
   nackte LAN-IP funktioniert die App vollständig und „Zum Startbildschirm" gibt
   es trotzdem – nur der Offline-Cache bleibt aus. Für die volle PWA einen
   Reverse-Proxy mit Zertifikat davorschalten (Caddy macht das mit zwei Zeilen)
   oder im Heimnetz z. B. Tailscale (`https://…ts.net`) nutzen.

**Mobil-Layout prüfen:** [scripts/mobile-sim.sh](scripts/mobile-sim.sh) startet einen
headless Edge als iPhone (375×812, DPR 3, Touch), meldet sich an, legt Screenshots
aller Kernseiten ab und misst dabei, **welches Element** breiter als der Viewport
ist. Ein sauberer Lauf meldet `scrollW: 375` und `bad: []`.

Der Service Worker cacht nur die App-Hülle und die gehashten Assets —
`/api` und `/socket.io` werden **nie** gecacht, Serverstatus ist immer live.
Die Icons entstehen aus [gen-icons.mjs](frontend/scripts/gen-icons.mjs)
(pures Node, ohne Abhängigkeiten): `node scripts/gen-icons.mjs` im
`frontend/`-Ordner erzeugt sie neu.

## Technisches

**Backend** – Node 22, TypeScript, Fastify, Prisma/PostgreSQL, Socket.IO, Dockerode.

- Konsole: Docker-Log-Stream wird pro Server einmal geöffnet und an alle Zuschauer verteilt.
- Befehle laufen über einen eigenen RCON-Client (Source-RCON-Protokoll), mit `stdin` als Fallback.
- `server.properties` verwaltet das Panel selbst – das Image bekommt
  `OVERRIDE_SERVER_PROPERTIES=false`, damit Änderungen einen Neustart überleben.
- Änderungen an RAM, Version, Typ oder Umgebung setzen den Container neu auf;
  das Datenverzeichnis bleibt dabei unangetastet. Weicht ein **gestoppter**
  Container von den gespeicherten Einstellungen ab, wird er beim nächsten Start
  automatisch neu aufgesetzt – ein laufender Server bleibt unangetastet.
- **Die Java-Version wird aus der Minecraft-Version abgeleitet**, nicht pauschal
  `latest` genommen. Mojang bindet jede Ausgabe an eine JVM-Generation, und Mods
  brechen auf zu neuen JVMs — ein 1.20.1-Pack auf Java 25 stirbt zum Beispiel im
  nativen Code des Spark-Profilers (`SIGSEGV` in `libasyncProfiler.so`).

  | Minecraft | Image |
  |---|---|
  | ≤ 1.16.5 | `itzg/minecraft-server:java8` |
  | 1.17 – 1.20.4 | `…:java17` |
  | 1.20.5 und neuer | `…:java21` |

  Überschreiben geht pro Server über die Umgebungsvariable `MC_IMAGE`
  (Tab *Einstellungen*) oder global über `MC_IMAGE` in der `.env`.

- Das Container-Limit liegt bewusst über dem Java-Heap: `+50 %`, mindestens 1 GB,
  höchstens 4 GB. Metaspace, Code-Cache, GC-Strukturen, Thread-Stacks und Direct
  Buffers brauchen Platz — bei einem Modpack mit ~400 Mods und 8 GB Heap wurden
  9,58 GB anonymer Speicher gemessen. Das Limit ist eine Obergrenze, keine
  Reservierung: großzügig zu rechnen kostet nichts, zu knapp killt Docker den
  Server mitten im Spiel. Die Anzeige „Arbeitsspeicher" bezieht sich auf dieses Limit.

  | Java-Heap | Container-Limit |
  |---|---|
  | 2 GB | 3 GB |
  | 4 GB | 6 GB |
  | 8 GB | 12 GB |
  | 16 GB | 20 GB |
- Lang laufende Aktionen (Modpack-Installation, Backups) laufen als Task mit
  Fortschritt und Protokoll, live per WebSocket.
- Das Sitzungs-Geheimnis kommt aus der Umgebung, sonst aus `data/.jwt-secret`, sonst wird
  eines erzeugt und dort abgelegt. So läuft `docker compose up` ohne Vorbereitung, und die
  Anmeldungen überleben trotzdem einen Neustart – ein bei jedem Start neu gewürfeltes
  Geheimnis würde alle Sitzungen ungültig machen.
- Den Host-Pfad des Datenverzeichnisses liest das Panel beim Start aus den Mounts seines
  **eigenen** Containers (`docker inspect` auf sich selbst). Sonst müsste man ihn doppelt
  angeben – einmal als Volume, einmal als `HOST_DATA_ROOT` – und ein Tippfehler fällt erst
  auf, wenn der erste Minecraft-Server mit leerem Verzeichnis startet. Eine gesetzte
  Umgebungsvariable hat weiterhin Vorrang.
- Das Alles-in-einem-Abbild kommt ohne Prozess-Supervisor aus: drei Dienste, feste
  Startreihenfolge, und fällt einer aus, endet der Container – den Neustart übernimmt
  Docker beziehungsweise Unraid. Halb laufende Container sind schwerer zu erkennen als
  abgestürzte.
- Das Backup-Speicherziel steht in der `Setting`-Tabelle, nicht in der Umgebung – es soll
  ohne Neustart des Stacks umstellbar sein. Das Kopieren läuft als Schritt des Backup-Tasks
  (sichtbar als „Zweitkopie wird geschrieben“) und darf scheitern, ohne die Sicherung zu
  entwerten – die Hauptkopie liegt dann bereits vollständig auf der Platte, und die
  Meldung sagt, dass die Zweitkopie fehlt.
  - **S3** läuft über `@aws-sdk/lib-storage` mit 64-MB-Teilen; bei 10.000 erlaubten Teilen
    reicht das für 640 GB je Archiv. Beim Zurückholen lädt das Panel in eine temporäre
    Datei und räumt sie nach dem Streamen wieder weg.
  - **Samba** wird zur Laufzeit als CIFS-Mount unter `/mnt/backup-target` eingehängt; danach
    ist die Freigabe ein normaler Ordner und das Kopieren erledigt der Kernel. Nach einem
    Neustart des Backends hängt sich die Freigabe selbst wieder ein.
    Dafür stehen in der `docker-compose.yml` beim Backend `cap_add: [SYS_ADMIN,
    DAC_READ_SEARCH]` und `security_opt: ["apparmor:unconfined"]`. Wer Samba nicht braucht,
    kann beide Zeilen streichen – S3 und der übrige Betrieb laufen ohne. Gemessen am
    Docker-Socket, der ohnehin root-gleiche Rechte auf dem Host gibt, kommt dadurch kein
    zusätzliches Risiko hinzu.
  - Geprüft wird an einem zweiten Einhängepunkt (`/mnt/backup-probe`): ein Probelauf mit
    fremden Zugangsdaten darf die laufende Einbindung nicht ersetzen, sonst schriebe das
    Panel danach auf eine Freigabe, die nie gespeichert wurde.
  - Ob etwas eingehängt ist, wird aus `/proc/mounts` gelesen, nicht aus der Ausgabe von
    `mount`: im Container gibt es keine `/etc/mtab`, busybox' `mount` gibt dann nichts aus –
    und jede Einbindung würde sich auf die vorige stapeln, bis der Punkt als belegt gilt.
  - S3-Fehler werden übersetzt: `HeadBucket` antwortet ohne Rumpf, das SDK meldet sonst nur
    „UnknownError“, obwohl der Status-Code (403 / 404 / 301) die Ursache genau benennt.
- Der Benachrichtigungs-Wächter pollt alle Server im 20-Sekunden-Takt, unabhängig davon,
  ob jemand im Panel zuschaut – die Status-Abfrage der Oberfläche läuft nur bei geöffnetem
  Tab und würde einen nächtlichen Absturz verschlafen. Ein Stopp über das Panel setzt in
  `docker.ts` eine Markierung, damit ein per SIGKILL beendeter Container nicht als Absturz
  gilt (gleicher Exit-Code); sobald der Server wieder läuft, fällt die Markierung weg.
  Je Kanal, Ereignis und Server gehen höchstens 3 Nachrichten pro 10 Minuten raus – eine
  Absturzschleife erzeugt sonst hundert Discord-Nachrichten; unterdrückte werden gezählt
  und in der nächsten Meldung erwähnt.
- Der Cron-Auswerter für Automatisierungen ist selbst geschrieben
  ([cron.ts](backend/src/services/cron.ts)) — 5 Felder, `*`, Listen, Bereiche und
  Schrittweiten, Vixie-Semantik bei Tag/Wochentag. Ein Timer prüft alle 20 Sekunden,
  merkt sich die zuletzt ausgeführte Minute pro Regel und feuert deshalb höchstens
  einmal pro Minute. „Nach Absturz“ vergleicht den Containerstatus mit dem letzten
  Durchlauf; ein Stopp über das Panel zählt nicht als Absturz.

**Frontend** – React 18, Vite, TailwindCSS, TanStack Query, Socket.IO-Client.

Die Optik folgt einem Entwurf aus Claude Design (`MCPanel.dc.html`). Jede Fläche
besteht aus zwei Lagen: einem erhabenen Steinrahmen (`.mc-frame`) und einer
vertieften Innenfläche (`.mc-frame-inner`) — der Inventar-Look von Minecraft.
Dazu Pixel-Schrift für Überschriften (Press Start 2P / Silkscreen), Monospace für
Messwerte, Grasnarbe als Zierleiste und vertiefte Schienen (`.mc-well`) für
Eingaben, Diagramme und Fortschrittsbalken.

Wiederverwendbare Bausteine liegen in [pixel.tsx](frontend/src/components/pixel.tsx):
Blocksymbole, Balkendiagramme, Fortschrittsschienen, Pixelköpfe, Ladeplatzhalter
und die Hooks `useHistory` (gleitender Messwertverlauf) und `useCountUp`.
Die Farb- und Schattenwerte stehen zentral in
[tailwind.config.js](frontend/tailwind.config.js), die Klassen in
[index.css](frontend/src/index.css) — Änderungen dort schlagen auf alle Seiten durch.

**Sicherheit**
- Passwörter mit bcrypt gehasht, Sitzungen über JWT
- Rechteprüfung serverseitig bei jedem Zugriff, auch auf dem WebSocket
- Dateimanager mit Schutz gegen Pfad-Traversal, Modpack-Entpacker gegen Zip-Slip
- Das Backend braucht Zugriff auf den Docker-Socket – das entspricht Root-Rechten
  auf dem Host. Nur auf Maschinen betreiben, denen du vertraust.

---

## Wenn ein Server nicht installiert

Bleibt der Installer beim Herunterladen hängen (`SocketTimeoutException`, „Downloading
minecraft server failed“), liegt es fast immer am Netz des Docker-Hosts, nicht am Panel.
Zwei Prüfungen grenzen es ein:

```bash
docker run --rm --network mcpanel_mcpanel alpine sh -c "getent ahostsv4 piston-data.mojang.com; wget -q -T 30 -O /dev/null https://piston-data.mojang.com/v1/objects/59353fb40c36d304f2035d51e7d6e6baa98dc05c/server.jar && echo OK || echo FEHLER"
```

Kommt `OK`, war die Störung vorübergehend – Server einfach noch einmal starten, der
Installer läuft dann erneut. Kommt `FEHLER` oder eine unerwartete IP-Adresse, filtert
vermutlich der Namensserver des Hosts. Auf Heimservern läuft dort oft Pi-hole oder
AdGuard, und die Container erben diesen Resolver. Abhilfe schafft `MC_DNS`:

```bash
MC_DNS=1.1.1.1,9.9.9.9
```

In Unraid steht das Feld unter *Show more settings* als **DNS für Minecraft-Server**.
Die Angabe gilt nur für die Minecraft-Container, nicht für das Panel selbst; bestehende
Server werden beim nächsten Start mit der neuen Einstellung neu aufgesetzt.

---

## Bekannte Grenzen

- Einzelner Host: es gibt keine Verteilung auf mehrere Docker-Knoten.
- Manche CurseForge-Autoren verbieten API-Downloads. Das Panel versucht die CDN-URL
  als Ausweichweg; klappt das nicht, meldet es die betroffene Datei im Protokoll und
  du legst sie über den Dateimanager selbst ab.
- Server müssen für Spieler von außen erreichbar sein – Portfreigaben im Router bzw.
  in der Firewall sind Handarbeit.
- Kein HTTPS im Stack. Für den Betrieb im Internet einen Reverse-Proxy
  (Caddy, Traefik, nginx) mit Zertifikat davorsetzen.

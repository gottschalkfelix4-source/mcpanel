# AGENTS.md

Selbstgehostetes Web-Panel für Minecraft-Server (Modpack-Installer für Modrinth/CurseForge, Mehrbenutzerbetrieb, Backups, Automationen, Subdomain-Proxy). Jeder Minecraft-Server läuft als eigener Docker-Container (`itzg/minecraft-server`), das Panel steuert sie über den Docker-Socket.

## Unverhandelbare Konventionen

- **Die gesamte Sprachwelt des Projekts ist Deutsch**: UI-Texte, API-Fehlermeldungen, Log-Zeilen, Code-Kommentare, Testbeschreibungen **und Commit-Messages**. Nie englische Nutzerstrings einbauen, auch wenn die Datenbankfelder englisch heißen.
- **Backend ist ESM** (`"type": "module"`): Imports brauchen die `.js`-Endung auch für `.ts`-Dateien (z. B. `import { prisma } from '../db.js'`). `moduleResolution: "Bundler"`, daher geht `tsx` ohne Empfindlichkeiten.
- Schemas/Validierungen vor allem mit **zod**; Fehler werfen über `HttpError`-Fabriken aus `src/lib/errors.ts` (`badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`), nie mit rohem `Error`.
- **Es gibt keine Prisma-Migrationsdateien.** `prisma/schema.prisma` ist die einzige Quelle, produktiv wird per `prisma db push` synchronisiert (entrypoint.sh und `npm start`). Eine Schema-Änderung = Schema editieren, dann `npm run build` (führt `prisma generate` aus) und Test-DB pushen.
- API-Fehlerformat ist einheitlich `{ error: string, details?: [{ path, message }] }`; zentraler Error-Handler in `src/index.ts` (Zod → 400 mit details, HttpError → Statuscode, Prisma P2002 → 409, 413 → „Datei ist zu groß“).

## Befehle

### Backend (`backend/` – Node 22, Fastify 4, Prisma, Socket.IO)
| Befehl | Zweck |
|---|---|
| `npm run dev` | `tsx watch src/index.ts`, Hot-Reload. Braucht `DATABASE_URL` (Postgres) und einen Docker-Socket. |
| `npm run build` | `prisma generate && tsc -p tsconfig.json` (Ausgabe nach `dist/`) |
| `npx tsc -p tsconfig.json --noEmit` | Nur Typecheck – läuft so in der CI |
| `npm test` | `vitest run`. Unit-Tests sind gemockt (Datenbank/Docker/Dateisystem) und laufen ohne Infrastruktur. |
| `npm run start` | `prisma db push --skip-generate && node dist/index.js` |

### Frontend (`frontend/` – React 18, Vite 5, Tailwind, React Query, socket.io-client)
| Befehl | Zweck |
|---|---|
| `npm run dev` | Vite auf :5173; proxy `/api` und `/socket.io` per Default auf `http://localhost:8080` (der laufende Compose-Stack). Für ein lokal gestartetes Backend: `VITE_API_PROXY=http://localhost:3000`. |
| `npm run build` | `tsc -b && vite build` |

### Docker
- `docker compose up -d` → Panel auf **http://localhost:8080**. Keine `.env` nötig; JWT-Secret wird beim ersten Start unter `<data>/.jwt-secret` selbst erzeugt.
- Zwei Betreibervarianten: Compose-Stack (3 Container + Postgres) und das **Alles-in-einem-Abbild** (Postgres+nginx+Backend in einem Container, für Unraid/Synology) – Wurzel-`Dockerfile` + `docker/entrypoint.sh`, gezogen als `ghcr.io/…`-Image.
- Datenlayout unter `DATA_ROOT` (im Container `/data`): `servers/<id>/`, `backups/<id>/`, `cache/`, `proxy/routes.json`, `.jwt-secret`, im Alles-in-einem zusätzlich `postgres/`.

### Integrationstests (`backend/audit/`)
- Diese Testdateien **überspringen sich selbst**, wenn ihre Umgebungsvariablen fehlen – `npm test` ist davon unberührt.
- Ausnahme: `audit/sftp.test.ts` braucht keine Infrastruktur und läuft in der CI mit `AUDIT_SFTP_TESTS=1` – lokal vor dem Push ebenso `AUDIT_SFTP_TESTS=1 npm test`, sonst fällt ein fehlender Mock erst in der CI auf.
- Nur gegen eine **Wegwerf-Datenbank** laufen lassen (leert Tabellen!):
  ```sh
  AUDIT_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/mcpanel_audit \
  DATA_ROOT=/tmp/mcpanel-test-NEUER-LAUF \
  MC_ROUTER_BIN=/absoluter/pfad/mc-router \
  npx vitest run audit/integration.test.ts audit/router.test.ts
  ```
  Schema vorher in dieser Test-DB anlegen (`prisma db push`). Niemals eine produktive `DATABASE_URL` verwenden.

### Notfall-CLI
Im Alles-in-einem-Container: `docker exec mcpanel node dist/cli.js <befehl>` – `benutzer`, `passwort`, `admin`, `aktivieren`, `zweifaktor-aus`, `sicherung`, `einspielen`. Existiert, weil die Anmeldung die einzige Tür ins Panel ist; wird genutzt, wenn niemand mehr reinkommt.

## Architektur und Datenfluss

```
React (nginx) ── HTTP /api (Bearer JWT) + /socket.io ──► Fastify-Backend ── dockerode ──► mc-<id>-Container (itzg/minecraft-server)
                                                              │  │  │                        │
                                                              │  │  └─► RCON (Spieler, Befehle) + Log-Streams
                                                              │  └────► Socket.IO-Gateway (Konsole/Status/Tasks)
                                                              └───────► PostgreSQL (Prisma)
  optional: itzg/mc-router:1.46.5 (#mcpanel-router) ── Subdomains auf mc-<id>:25565 (routes.json + SIGHUP)
```

- **`backend/src/index.ts`**: Fastify-Assembly, Error-Handler, `/api/health` (macht eine **echte** DB-Abfrage – 503 = Container wird neu gestartet), Socket.IO-Setup, `bootstrap()`.
- **`backend/src/bootstrap.ts`**: Startreihenfolge – Datenverzeichnisse, Docker-Netz, Host-Pfad-Erkennung, Admin-Konto (nur bei leerer Benutzertabelle), Proxy-Abgleich, Autostarts, Watcher, Scheduler.
- **`backend/src/routes/*`**: Fastify-Plugins unter `/api/<bereich>`. Muster: `app.addHook('preHandler', authenticate)`, dann je Route `requireServer(req, PERMISSION)` bzw. `access.can(p)`; `files.ts`, `content.ts`, `config.ts` zusätzlich mit `guardMutations(app)` (umwickelt Nicht-GET-Handler mit der Serversperre).
- **`backend/src/services/*`**: Geschäftslogik, Tests als colocated `*.test.ts` daneben.
- **`backend/src/auth/`**: JWT (Lebensdauer 7d, Widerruf über `sessionVersion` pro User – Passwortwechsel erhöht sie), `authenticateToken` lädt den User **frisch aus der DB** (Rolle/aktiv), `getServerAccess` lädt **frische Mitgliedsrechte je Anfrage**.
- **`backend/src/ws/`**: Socket.IO-Gateway. Einnahmequelle für Auth: `socket.data.token` aus dem Handshake. Wichtig: `emitToServer` **re-authentifiziert jeden einzelnen Empfänger** (Token + Serverzugriff) vor jedem emit und wirft Fehler zurück – das war der Fix für Rechteentzug bei offenen Verbindungen.
- **`frontend/src/lib/`**: `api.ts` (Fetch-Wrapper, Token in `localStorage['mcpanel.token']`, 401-Handling, `authedUrl()` für Downloads mit Token als Query-Parameter), `socket.ts` (eine gemeinsame Socket.IO-Verbindung, `resetSocket()`), `auth.tsx` (AuthProvider), `types.ts`.

## Die wichtigsten impliziten Muster und Stolperfallen

1. **Serversperre (nicht verpassen!)**: Alle Operationen an einem Server (Backup, Restore, Modpack-Install/Update, Power, Datei- und Config-Änderungen, Automationen) müssen über `withServerOperation` (exklusiv, reentrant via `AsyncLocalStorage`) bzw. `withQueuedOperation` (warteschlangt) laufen – sonst entstehen halb fertige Zustände. Konflikt = deutscher Fehler „X läuft für diesen Server bereits.“ Reentranz ist wichtig: ein Modpack-Update legt intern ein Sicherheits-Backup an, ohne sich selbst zu blockieren.
2. **Tasks**: Langläufer erzeugen über `createTask` eine Task-Zeile mit Fortschritt/Log und pushen live über Socket.IO (`task`-Event). Log auf 60 000 Zeichen gekappt. `runTask` wartet auf Abschluss und übernimmt Fehler (Automationen dürfen nicht „OK“ melden, bevor die Modpack-Installation fertig ist).
3. **Rechtesystem**: 15 einzelne Permissions (inkl. `backup.download`, `world.pregen`) (`auth/permissions.ts`), Admin/Besitzer bekommen alle; Einladungen starten mit `DEFAULT_MEMBER_PERMISSIONS`. **Server anlegen ist Administrator-Sache.** `PROTECTED_ENV_KEYS` (MC_IMAGE, JVM_OPTS, JAVA_TOOL_OPTIONS, MEMORY, RCON_*, CUSTOM_SERVER, …) und alles, worüber das Abbild fremde Dateien nachlädt oder Operatoren setzt (`MODS`, `PLUGINS`, `*_DOWNLOAD_URL`, `CF_*`, `OPS`, … – Muster in `isProtectedEnvKey()` in docker.ts; neue Variablen dieser Art dort ergänzen; Variablennamen werden per Regex geprüft, `TYPE=CUSTOM` ebenfalls nur Admin) darf nur ein Admin ändern – geprüft wird gegen den **gespeicherten** Stand, weil das UI `extraEnv` immer vollständig zurückschickt. Genauso den Arbeitsspeicher (`memoryMb`): `assertMemoryAllowed` (`services/quota.ts`) lässt Nicht-Admins nur den gespeicherten Wert durch – in Einstellungen, Neuinstallation, ZIP-Import und Assistent.
4. **Sicherheit Pfadgrenzen**: `safePath()` lehnt Symlinks in jeder Pfadkomponente ab und begrenzt komponentenweise; `archivePath()` zusätzlich Traversal/Absolutpfade/Laufwerksbuchstaben. Faustregel aus dem Code: **nach jedem `await` vor einer Dateisystem-Mutation `safePath` erneut aufrufen** (TOCTOU).
5. **Downloads schreiben erst in eine temporäre Datei und ersetzen atomar per rename** – eine bestehende Mod/Datei darf durch einen fehlgeschlagenen Download nicht zerstört werden.
6. **Backup/Restore**: ZIP über den eigenen Schreiber `lib/zipWriter.ts` (bereits komprimierte Endungen wie `.mca`/`.jar` werden abgelegt statt gepackt, kleine Dateien parallel gepackt, ZIP64 ab 4 GiB). Das Format wird am Dateianfang erkannt (`archiveFormat`), alte tar.gz-Sicherungen laufen weiter über das `tar`-Paket. Eingespielt wird ZIP mit demselben abgesicherten Entpacker wie beim Import (`readZipEntries`/`extractServerZip`). Restore prüft das Archiv zuerst, verschiebt den Altbestand dann separat und ist über ein Journal wiederanlaufbar (`restoreRecovery.ts`). `commitRestore(id, moved)` hängt Ordner, die der neue Stand unverändert übernimmt, per `rename` um statt sie zu kopieren (Modpack-Installation: `untouchedDirs()` – alles, in das das Paket nichts schreibt, also Welt, Karten, `backups/`; nie `mods`/`kubejs`). Die Namen stehen im Journal (`moved`); `recoverInterruptedRestore` legt sie zurück, **bevor** es den neuen Ordner löscht, und bricht ab, statt zu löschen, wenn das nicht eindeutig geht. Speicherziel: ist eines eingerichtet und `keepLocal` aus (Vorgabe), schreibt `createBackup` das ZIP **direkt dorthin** – `writeZipStream` (fortlaufend, große Dateien mit Data Descriptor im ZIP64-Format) in `openBackupSink` (SMB-Datei im Mount, S3-Multipart, WebDAV-PUT ohne Längenangabe), ohne lokale Datei und ohne Nachlesen (`verifyStatus` bleibt leer, „Prüfen“ holt es nach). Schlägt das fehl, läuft der alte Weg (lokal packen, prüfen, `putBackup`) und die lokale Kopie wird nach dem Hochladen gelöscht; ist das Ziel ganz weg, bleibt sie lokal (`mirrored = false`). Restore/Download/Prüfen holen das Archiv über `resolveArchive` → `fetchBackup` in eine Temp-Datei. Arten: Samba (bindet CIFS zur Laufzeit ein – deshalb `cap_add: [SYS_ADMIN, DAC_READ_SEARCH]` und `apparmor:unconfined` im Compose-File), S3 oder WebDAV (`services/webdav.ts`, reines HTTP, Upload unter Zwischenname + `MOVE`, keine Weiterleitungen; das gespeicherte Kennwort gilt nur für dieselbe Origin – `keepStoredSecrets`); Zugangsdaten liegen in der DB und werden nie zurückgegeben (`backupTarget.ts`).
7. **Frontend-Auth-Falle**: Bei `NetworkError` (Status 0 = Backend antwortet nicht, z. B. Container-Neustart) **nicht ausloggen** – nur ein echtes 401 verwirft Token/Socket/Query-Cache (`auth.tsx`, `api.ts`). Beim Login/Logout: `resetSocket()` + `queryClient.clear()`, sonst übernimmt der nächste Benutzer im selben Tab die Identität (BUG-07).
8. **Absturz vs. geplanter Stopp**: `docker.ts` merkt sich geplante Stopps (180s-Fenster, `wasPlannedStop`), der Crash-Detektor und der Crash-Scheduler müssen das beachten, sonst meldet jeder Stop einen Absturz. Der Callback-Hook (`onPlannedStop`) existiert, um einen Import-Ringschluss zwischen `docker.ts` und `notify.ts` zu vermeiden.
9. **Java-/Image-Wahl**: Image wird nicht pauschal `latest` – `javaTagForVersion()` mappt MC-Version → Java-Tag (≤1.16 → java8, ≤1.19 → java17, ab 1.20.5 → java21). Nur mit `MC_IMAGE` überschreibbar (admin-only).
10. **RCON**: Verbindungen werden wiederverwendet, Spielerabfragen gebündelt; online-Player-Poll alle 5 s, `usercache.json` (bekannte Spieler) alle 20 s. Der Panel-Container verbindet sich beim Start selbst mit dem Minecraft-Netz (Unraid), damit RCON ohne veröffentlichten Port funktioniert.
11. **Platzhalter-Geheimnisse werden abgelehnt**: bekannte `JWT_SECRET`-Beispielwerte (in `config.ts` `JWT_PLATZHALTER`) und `ADMIN_PASSWORD`-Platzhalter (in `bootstrap.ts`) → Universum, in dem nie produktiv mit `changeme123` gestartet wird. Beim Bootstrap wird das Konto dann einfach übersprungen (Assistent bleibt der Weg), nicht abgebrochen.
12. **BigInt**: `db.ts` patcht `BigInt.prototype.toJSON`, damit Prisma-BigInt-Werte (Backup-Größen) serialisierbar sind.
13. **CRLF tötet Container**: `.gitattributes` erzwingt LF; das Wurzel-Dockerfile konvertiert `entrypoint.sh` zusätzlich per dos2unix. Beim Erstellen von Skripten LF beibehalten.
14. **CI-Besonderheiten** (`.github/workflows/docker.yml`): Build mit `oci-mediatypes=false`, `provenance: false`, `sbom: false`, nur `linux/amd64` – sonst erkennt Unraids Update-Check das Image nicht mehr (falsche Medientypen bzw. Attestations-Index).
15. **Namen/icons der MC-Container**: Containername aus dem Panel-Servernamen (Leerzeichen → Bindestrich, Umlaute ausgeschrieben, ID-Suffix bei Kollision), Modpack- oder Loader-Logo über `net.unraid.docker.icon`.
16. **Rate-Limit nur dezentral**: `@fastify/rate-limit` ist global deaktiviert und nur dort aktiv, wo eine Route es ausdrücklich verlangt – Konsole/Status/Uploads bleiben unbegrenzt. Außerdem `trustProxy: 'loopback, uniquelocal'` (nginx steht immer davor, sonst landen alle Nutzer im selben Rate-Limit-Zähler) und ein leerer JSON-Body wird als `{}` akzeptiert (Aktions-Endpunkte).
17. **Absturzdiagnose in zwei Stufen**: `crashAnalysis.ts` ist regelbasiert und rein (Fabrics „provided by"/„requires … which is missing" schlagen den Stacktrace; `server-intermediary.jar` & Co. sind nie verdächtig; bei der Sprachdatei-NPE schaut es in die Jars). `services/assistant.ts` ist die optionale zweite Stufe: Anthropic direkt über das offizielle SDK (`assistantAnthropic.ts`, `assistant.provider = anthropic`) oder ein OpenAI-kompatibler Dienst (Einstellungen `assistant.*`, Key nie zurückgeben; ein gespeicherter Key gilt nur für den Anbieter, mit dem er gespeichert wurde), der Protokoll + Modliste + Diagnose bekommt. Das Modell selbst hat **keine Werkzeuge**; `assistantActions.ts` liest aus seiner Antwort höchstens Vorschläge (`AKTION: {…}`, feste Typen per zod), die der Nutzer einzeln freigeben muss – Rechte werden beim Vorschlagen und frisch bei der Freigabe geprüft, ausgeführt wird als Task unter der Serversperre, jeder Vorschlag genau einmal (`inArbeit`). Route `POST /servers/:id/assistant/ask` (CONSOLE_READ, rate-limited), Verlauf hält der Client.
18. **Effektiver Loader = `serverLoader()`** in `content.ts` – bei `MODPACK` steht er in `extraEnv.TYPE`, ein gesetztes `TYPE` gewinnt immer (so kommt es auch im Container an). Nicht erneut aus `server.type` ableiten; das war dreimal kopiert und jedes Mal anders.
19. **Java-Abbild nach Version**: Mojang zählt seit 26.1 nach Jahr; `javaTagForVersion()` gibt dafür und für alles Unbekannte (`LATEST`, Schnappschüsse) das neueste bekannte Java – zu alt geraten bricht mit `UnsupportedClassVersionError`, zu neu läuft meist.

20. **Uploads halten die Serversperre nicht**: Dateimanager und SFTP streamen in eine `.upload-*`- bzw. `.sftp-upload-*`-Temp-Datei und rufen erst zum `rename` `waitForServerOperation` auf. Backups filtern diese Temp-Dateien heraus (`isUploadTemp`). Kontingent: `computeDiskUsage` nutzt 30 s lang den Cache, Uploads korrigieren ihn per `adjustDiskUsage`.
21. **Downloads per Kurzzeit-Token**: `?token=` akzeptiert nur noch Tokens aus `POST /auth/download-token`, gebunden an genau einen Pfad (`canonicalDownloadPath`). Sitzungs-JWTs gehören nie in eine URL. Im Frontend: `downloadFile(path)` aus `lib/api.ts`.
22. **Anmeldung mit zweitem Faktor**: `/auth/login` antwortet bei aktivem TOTP mit `{ mfaRequired, mfaToken }`, danach `/auth/login/totp`. SFTP erwartet Passwort + Code am Stück. Aktivieren und „überall abmelden“ erhöhen `sessionVersion` und liefern ein neues Token zurück.
23. **Einrichtungscode**: Der Assistent (`routes/setup.ts`) verlangt den Code aus dem Containerprotokoll bzw. `<data>/.setup-code`. Er verfällt nach abgeschlossener Einrichtung.

24. **Nodes (weitere Docker-Hosts)**: `serverDir()`/`serverHostDir()` fragen die synchrone Standort-Registry `lib/serverLocation.ts` (geladen in `bootstrap` per `loadNodes()`, gepflegt bei Anlegen/Umzug/Löschen). Liegt ein Server auf einer Node, zeigt `serverDir` in deren per CIFS eingehängte Freigabe `<data>/nodes/<id>/servers/<id>` – Dateicode bleibt dadurch unverändert. Docker immer über `dockerFor(server)` (nie direkt `docker` für Serveroperationen), RCON über `rconTarget()`. Ein Server auf unbekannter Node wirft, statt still lokal zu laufen. `setOperationGuard` lässt `withServerOperation` für getrennte Nodes mit 503 scheitern; `getState` liefert dann `unreachable` (Benachrichtigungen ignorieren das). Agent = dasselbe Abbild mit `MCPANEL_ROLE=node` (`src/node/agent.ts`): Docker-Socket-Proxy mit Token in der ersten Anfrage je Verbindung, Samba, `/status`. Zwei Verbindungsarten: `wireguard` (Panel wählt sich ein, `tunnel.ts`, braucht NET_ADMIN) und `direct` (LAN, Token + SMB3-`seal`). Zwei Plattformen: `linux` (Agent im Host-Netz, Bind-Mounts) und `windows` (Docker Desktop: Agent im Minecraft-Netz mit veröffentlichten Ports aus `agentPorts()`, Daten im Volume `mcpanel-node-data` per Volume-Subpath, PowerShell-Installer). RCON geht auf Nodes immer über die Weiterleitung des Agenten (erste Zeile `MCPANEL-RCON <token> <container>`), nie über veröffentlichte Ports. Profil steckt Base64-kodiert im Installationsbefehl (`installScript` in `nodes.ts`). Agent-Update per Knopf (`services/nodeUpdate.ts`): das Panel startet über die Docker-API der Node einen Helfer mit `MCPANEL_ROLE=node-update` (`node/updater.ts`), der `mcpanel-node` mit gleichen Einstellungen und neuem Abbild ersetzt und bei Fehlschlag den alten zurückholt – der Agent kann sich nicht selbst ersetzen, weil die Verbindung über ihn läuft. Doku: `docs/NODES.md`.

25. **Zusatzports & UniFi**: Erweiterungen mit eigenem Port (`services/modPorts.ts`: Simple Voice Chat, Geyser, BlueMap, Dynmap, squaremap, Votifier) erkennt `syncServerPorts` (`services/serverPorts.ts`) **vor jedem Start** über den Hook `onServerStart` in docker.ts (Rückruf statt Import, gesetzt in `bootstrap`). Tabelle `ServerPort`, Hostport panelweit eindeutig; `portBindings()` liest synchron aus `lib/serverPorts.ts` (wie `serverLocation`). `samePort`-Erweiterungen (Sprachchat teilt Clients den Port mit) bekommen den freien Port in ihre Konfiguration geschrieben, alle anderen nur ein anderes Host-Mapping. Router: `services/unifi.ts` gleicht Regeln mit Präfix „MCPanel “ über die klassische API (`/proxy/network/api/s/<site>/rest/portforward`) ab – fremde Regeln nie anfassen; Auth per `X-API-KEY` oder Cookie+CSRF; TLS-Fingerabdruck wird auf einer vorab aufgebauten Verbindung geprüft, **bevor** die Anfrage gesendet wird. Nach Port-/Namens-/Proxy-Änderungen `scheduleUnifiSync()` rufen. Erkannte Ports entstehen mit `forward = false` (Portnummer kommt aus Dateien, die Mitglieder ändern können) – ein Admin schaltet sie ein oder setzt `autoForwardDetected`; ein geänderter Hostport verliert die Freigabe. Doku: `docs/UNIFI.md`.

26. **Karte & Vorgenerierung** (Reiter „Karte“, `routes/worldmap.ts`): Chunk-Status aus dem 4-KiB-Kopf der `.mca`-Dateien (`services/regionScan.ts`), Spielerpositionen per RCON `data get entity` (`playerPositions.ts`), Chunky nur über Konsolenbefehle; Fortschritt per `chunky progress`, Format aus Chunkys `en.json` (`pregen.ts` mit Monitor alle 5 s: Fortsetzen nach Neustart, Auto-Pause bei Spielern/TPS, `bluemap stop/start`). Auftrag liegt in der Einstellung `pregen.<serverId>`. Chunky/BlueMap kommen von Modrinth (`mapAddons.ts`, Auswahl nur über die Modrinth-Daten). BlueMap ist `internal` in `modPorts.ts`: lokal kein veröffentlichter Port, auf Nodes ohne Router-Freigabe; ausgeliefert über `/api/map-view/<token>/…` (`routes/mapView.ts`, eigenes HMAC-Token, Sandbox-CSP ohne `allow-same-origin` – BlueMap-Dateien sind von Mitgliedern beschreibbar). nginx braucht dafür den eigenen `location /api/map-view/` (SAMEORIGIN, ohne Pufferung). BlueMap ruft `localStorage` ungeschützt auf, was in der Sandbox wirft – deshalb setzt der Proxy in HTML-Seiten `STORAGE_SHIM` (Speicher im Arbeitsspeicher) ein; nie stattdessen `allow-same-origin` ergänzen. Doku: `docs/KARTE.md`.

27. **FTB-Teams-Partys** (`services/ftbTeams.ts`, `routes/teams.ts`, Abschnitt im Reiter „Spieler“): gelesen wird aus `<welt>/ftbteams/{party,player}/*.snbt` mit dem eigenen Leser `lib/snbt.ts` (FTB-Format: zeilenweise ohne Kommas); geändert **nur** über die Admin-Befehle des Mods (`force-add`, `force-remove`, `force-disband`, `party transfer_ownership_for`, `party settings_for`), nie über die Dateien. Die Party wird über ihren Kurznamen angesprochen (`shortName()`: `\W`→`_` + `#` + 8 Zeichen der ID) – den bildet das Panel selbst, Spielernamen und neue Namen sind per Regex geprüft. Ansehen = `console.read`, Ändern = `console.command`. Doku: `docs/FTB_TEAMS.md`.
28. **Anbieter-IDs sind Eingaben**: `projectId`/`versionId` von Modrinth/CurseForge wandern in API-Adressen und in Dateinamen des Modpack-Caches – in jedem Schema `providerId` aus `lib/providerId.ts` verwenden, nie `z.string()`.

29. **Autostart nur nach `resumeInterruptedRestore()`** (`services/restoreResume.ts`, unter der Serversperre): lokal im Bootstrap und in `runAutostart`, auf Nodes in `autostartNode` – die Freigabe einer Node ist beim Panel-Start oft noch nicht da. Der Altordner `.restore-old` *im* Serverordner gilt nur als echtes Verzeichnis und wird höchstens einmal geborgen (Mitglieder können ihn anlegen).

30. **Reguläre Ausdrücke über Dateien von Mitgliedern**: mit dem `m`-Schalter nie `\s*` am Zeilenanfang (frisst Zeilenumbrüche → quadratisch, blockiert die Ereignisschleife), sondern `[ \t]*`. Erkannte Zusatzports dürfen nie 25565/25575 im Container sein.

31. **Konsolen-Stream**: Zuschauer je Server als Set von Socket-IDs (`ws/console.ts`), kein Zähler. Socket-Acks geben nur `HttpError`-Meldungen weiter. Hintergrund-Intervalle (Vorgenerierung, Spielerstatistik, Zeitpläne) überspringen einen Durchlauf, solange der vorige läuft.

32. **Alles-in-einem lauscht nur lokal**: der Entrypoint setzt `MCPANEL_HOST=127.0.0.1` (`config.host`); im Compose-Stack bleibt es `0.0.0.0`, weil nginx dort ein eigener Container ist.

## Tests schreiben

- Vitest mit **aggressivem Mocking**: `vi.hoisted`-Mocks + `vi.mock` für Prisma, Docker, RCON, Config (siehe `backups.test.ts`, `modpack.install.test.ts`), Dateisystem teils echt in `fs.mkdtemp`-Verzeichnissen. Neue Integrationstests ausschließlich in `backend/audit/` mit den obigen Umgebungsvariablen und Skip-Guard, sonst brechen sie andere Workflows.
- Vor dem Abschluss: `npm run build` (typisiert + Prisma generiert) und `npm test` im Backend; Frontend baut mit `npm run build`. CI macht exakt: Build → `npm test`.
- `BUGS.md` dokumentiert ein Sicherheits-/Datenintegritäts-Audit (35 Befunde, Stand 08/2026, alle behoben) – lesenswert, bevor man an Dateimanager, Modpack, Restore oder Auth herangeht, denn dort stecken bewusste, testbewehrte Absicherungen.

## Wo was liegt

- `docs/MINECRAFT_PROXY.md` – Subdomain-Proxy-Einrichtung und Migration
- `unraid/mcpanel.xml` – Unraid-Template für das Alles-in-einem-Abbild
- `scripts/mobile-sim.sh` – Mobile-Simulation für die Oberfläche
- `frontend/scripts/gen-icons.mjs` – erzeugt PWA-Icons, läuft vor jedem Build
- `.claude/launch.json` – VSCode-Launch für `frontend-dev` (Port 5173)

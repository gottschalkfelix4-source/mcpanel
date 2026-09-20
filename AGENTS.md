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
- Nur gegen eine **Wegwerf-Datenbank** laufen lassen (leert Tabellen!):
  ```sh
  AUDIT_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/mcpanel_audit \
  DATA_ROOT=/tmp/mcpanel-test-NEUER-LAUF \
  MC_ROUTER_BIN=/absoluter/pfad/mc-router \
  npx vitest run audit/integration.test.ts audit/router.test.ts
  ```
  Schema vorher in dieser Test-DB anlegen (`prisma db push`). Niemals eine produktive `DATABASE_URL` verwenden.

### Notfall-CLI
Im Alles-in-einem-Container: `docker exec mcpanel node dist/cli.js <befehl>` – `benutzer`, `passwort`, `admin`, `aktivieren`, `sicherung`, `einspielen`. Existiert, weil die Anmeldung die einzige Tür ins Panel ist; wird genutzt, wenn niemand mehr reinkommt.

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
3. **Rechtesystem**: 13 einzelne Permissions (`auth/permissions.ts`), Admin/Besitzer bekommen alle; Einladungen starten mit `DEFAULT_MEMBER_PERMISSIONS`. **Server anlegen ist Administrator-Sache.** `PROTECTED_ENV_KEYS` (MC_IMAGE, JVM_OPTS, MEMORY, RCON_*, …) darf nur ein Admin ändern – geprüft wird gegen den **gespeicherten** Stand, weil das UI `extraEnv` immer vollständig zurückschickt.
4. **Sicherheit Pfadgrenzen**: `safePath()` lehnt Symlinks in jeder Pfadkomponente ab und begrenzt komponentenweise; `archivePath()` zusätzlich Traversal/Absolutpfade/Laufwerksbuchstaben. Faustregel aus dem Code: **nach jedem `await` vor einer Dateisystem-Mutation `safePath` erneut aufrufen** (TOCTOU).
5. **Downloads schreiben erst in eine temporäre Datei und ersetzen atomar per rename** – eine bestehende Mod/Datei darf durch einen fehlgeschlagenen Download nicht zerstört werden.
6. **Backup/Restore**: Tar.gz (`tar`-Paket); Restore prüft das Archiv zuerst, verschiebt den Altbestand dann separat und ist über ein Journal wiederanlaufbar (`restoreRecovery.ts`). Zweitablage: Samba (bindet CIFS zur Laufzeit ein – deshalb `cap_add: [SYS_ADMIN, DAC_READ_SEARCH]` und `apparmor:unconfined` im Compose-File) oder S3; Zugangsdaten liegen in der DB und werden nie zurückgegeben (`backupTarget.ts`).
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
17. **Absturzdiagnose in zwei Stufen**: `crashAnalysis.ts` ist regelbasiert und rein (Fabrics „provided by"/„requires … which is missing" schlagen den Stacktrace; `server-intermediary.jar` & Co. sind nie verdächtig; bei der Sprachdatei-NPE schaut es in die Jars). `services/assistant.ts` ist die optionale zweite Stufe: ein OpenAI-kompatibler Dienst (Einstellungen `assistant.*`, Key nie zurückgeben), der Protokoll + Modliste + Diagnose bekommt und **nur liest** – keine Werkzeuge, keine Aktionen. Route `POST /servers/:id/assistant/ask` (CONSOLE_READ, rate-limited), Verlauf hält der Client.
18. **Effektiver Loader = `serverLoader()`** in `content.ts` – bei `MODPACK` steht er in `extraEnv.TYPE`, ein gesetztes `TYPE` gewinnt immer (so kommt es auch im Container an). Nicht erneut aus `server.type` ableiten; das war dreimal kopiert und jedes Mal anders.
19. **Java-Abbild nach Version**: Mojang zählt seit 26.1 nach Jahr; `javaTagForVersion()` gibt dafür und für alles Unbekannte (`LATEST`, Schnappschüsse) das neueste bekannte Java – zu alt geraten bricht mit `UnsupportedClassVersionError`, zu neu läuft meist.

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

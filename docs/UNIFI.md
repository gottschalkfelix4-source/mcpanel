# Zusatzports und UniFi-Portfreigaben

Manche Erweiterungen brauchen neben dem Spielport einen eigenen Port. Das Panel
erkennt sie selbst, gibt den Port im Container frei und kann ihn auf einer
UniFi-Konsole (Dream Machine Pro, UDR, Cloud Gateway, Cloud Key Gen2+) im Router
weiterleiten – niemand muss nach der Installation einer Mod noch an den Router.

## Erkannte Erweiterungen

| Erweiterung | Protokoll | Standardport | Konfiguration |
|---|---|---|---|
| Simple Voice Chat | UDP | 24454 | `config/voicechat/voicechat-server.properties` bzw. `plugins/voicechat/…` (`port=`) |
| Geyser (Bedrock-Spieler) | UDP | 19132 | `plugins/Geyser-*/config.yml` bzw. `config/Geyser-*/config.yml` (`bedrock: port:`) |
| BlueMap | TCP | 8100 | `config/bluemap/webserver.conf` bzw. `plugins/BlueMap/webserver.conf` – nur über das Panel (Reiter „Karte“): kein veröffentlichter Port, auf Nodes ohne Router-Freigabe |
| Dynmap | TCP | 8123 | `plugins/dynmap/configuration.txt` bzw. `dynmap/configuration.txt` (`webserver-port:`) |
| squaremap | TCP | 8080 | `plugins/squaremap/config.yml` bzw. `config/squaremap/config.yml` |
| Votifier / NuVotifier | TCP | 8192 | `plugins/NuVotifier/config.yml` bzw. `plugins/Votifier/config.yml` |

Erkannt wird am Jar in `mods/` oder `plugins/` (deaktivierte `.jar.disabled`
zählen nicht), **vor jedem Start** des Servers oder per Knopf „Jetzt erkennen“
unter *Einstellungen → Zusätzliche Ports*. Ist eine Erweiterung nicht mehr
installiert, gibt das Panel ihren Port wieder frei.

**Mehrere Server mit derselben Erweiterung:** Jeder Hostport wird panelweit nur
einmal vergeben. Für Web-Karten, Geyser und Votifier legt das Panel einfach
einen freien Hostport (z. B. 8101) auf den unveränderten Port im Container.
Simple Voice Chat teilt den Spielern seinen Port selbst mit – dort schreibt das
Panel den freien Port in `voicechat-server.properties`, Host- und Containerport
sind dann gleich. Ein von Hand eingetragener, freier Port wird übernommen.

**Port auf dem Host schon belegt?** Läuft auf dem Docker-Host ein anderer Dienst
auf dem Port (klassisch: Home Assistant auf 8123, dem Standardport von Dynmap),
meldet Docker das erst beim Start. Das Panel merkt sich den Port dann dauerhaft
als belegt, vergibt den nächsten freien und startet erneut – ohne Zutun.

Für Erweiterungen, die das Panel nicht kennt, können Administratoren eigene
Ports ergänzen. Neue oder geänderte Ports gelten ab dem nächsten Start: der
gestoppte Container wird dann mit den neuen Freigaben neu aufgesetzt.

## UniFi anbinden

*Panel-Einstellungen → UniFi-Portfreigaben* (nur Administratoren):

1. **Adresse der Konsole**, z. B. `https://192.168.1.1`, Site meist `default`.
2. **Anmeldung** – eine von zwei Varianten:
   - **API-Schlüssel**: in der Konsole unter *Einstellungen → Steuerebene →
     Integrationen* erzeugen.
   - **Lokaler Benutzer**: eigenes lokales Konto mit Netzwerk-Administratorrechten
     und ohne Zwei-Faktor-Anmeldung (Ubiquiti-Cloud-Konten mit 2FA gehen nicht).

   Die offizielle Integrations-API von UniFi kennt keine Portweiterleitungen,
   das Panel nutzt deshalb die klassische Netzwerk-API der Konsole
   (`/proxy/network/api/s/<site>/rest/portforward`). Nicht jede Fassung der
   Netzwerk-Anwendung lässt dort einen API-Schlüssel zu – lehnt die Konsole ihn
   ab, sagt das Panel das und der lokale Benutzer ist der Weg.
3. **Weiterleiten an**: die feste LAN-IP des Docker-Hosts (z. B. des
   Unraid-Servers). Server auf Nodes im Heimnetz (Verbindung „direkt“) werden auf
   deren Adresse weitergeleitet, Server auf Nodes im Internet (VPS) nicht – die
   stehen nicht hinter dem UniFi-Router.
4. **Verbindung testen** und den angezeigten Zertifikats-Fingerabdruck
   bestätigen, dann **Speichern**.

Optional leitet das Panel auch die Spielports weiter (bzw. den Port des
Subdomain-Proxys).

### Freigabe erkannter Ports

Ein erkannter Port ist sofort im Container offen, im Router aber erst, wenn ein
Administrator am Server unter *Einstellungen → Zusätzliche Ports* den Schalter
„Router“ einschaltet. Grund: Die Portnummer steht in Konfigurationsdateien des
Servers, und die kann jedes Mitglied mit Dateirechten ändern. Wer allen
Mitgliedern vertraut, schaltet in den UniFi-Einstellungen „Erkannte Mod-Ports ohne
Rückfrage freigeben“ ein. Ändert sich der Port einer Erweiterung, muss die
Freigabe neu eingeschaltet werden. Ports unter 1024 werden nie übernommen.

Schlägt ein Abgleich fehl, versucht es das Panel nach 1, 3 und 10 Minuten erneut;
zusätzlich wird alle 15 Minuten abgeglichen.

### Was das Panel auf der Konsole tut

- Es fasst nur Regeln an, deren Name mit `MCPanel ` beginnt. Sie heißen
  `MCPanel <Server> <Zweck>`, z. B. `MCPanel Freunde Simple Voice Chat`.
- Belegt eine eigene Regel des Routers (z. B. „NAS“) schon den Port, wird sie
  nicht überschrieben; der Konflikt steht in den Einstellungen und am Server.
- Abgeglichen wird nach jedem Serverstart, nach Änderungen an Ports, Spielport,
  Proxy oder Servername, beim Löschen eines Servers, beim Panel-Start und per
  Knopf „Jetzt abgleichen“. Verwaiste Regeln des Panels werden entfernt.
- Beim Abschalten der Anbindung entfernt das Panel alle seine Regeln.

### Sicherheit

- API-Schlüssel und Passwort liegen in der Datenbank und werden nie an die
  Oberfläche zurückgegeben.
- UniFi-Konsolen haben meist ein selbstsigniertes Zertifikat. Das Panel pinnt
  dessen SHA-256-Fingerabdruck und prüft ihn beim Verbindungsaufbau, **bevor**
  die Anfrage samt Schlüssel gesendet wird. Ändert sich das Zertifikat (z. B. nach
  einem Konsolen-Update), stoppt der Abgleich mit einem Hinweis – dann erneut
  testen und bestätigen. Wer ein gültiges Zertifikat auf der Konsole hat, kann
  stattdessen die normale Zertifikatsprüfung erzwingen.
- Eigene Ports und Router-Freigaben je Port ändern nur Administratoren.

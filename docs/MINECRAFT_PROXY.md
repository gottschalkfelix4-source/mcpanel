# Minecraft-Server über Subdomains

MCPanel kann Java-Edition-Verbindungen anhand des angefragten Hostnamens an
verschiedene Minecraft-Container weiterleiten. Beispielsweise führen
`survival.example.de` und `mods.example.de` über denselben öffentlichen TCP-Port
zu unterschiedlichen Servern. Ein Server kann bis zu 20 Namen haben.

Das Panel verwaltet dafür den zusätzlichen Container `mcpanel-router` mit dem
festgelegten Image `itzg/mc-router:1.46.5`. Grundlage ist die
[offizielle mc-router-Dokumentation](https://github.com/itzg/mc-router/tree/v1.46.5).
Es handelt sich um Minecraft-Routing; die Webadresse des Panels wird dadurch nicht geändert.

## Einrichtung und Migration

1. Die neue Panel-Version bauen/starten. Die vorhandenen Startskripte gleichen
   das additive Prisma-Schema ab: Hostnamen, Direktzugriff, Sitzungsrevisionen
   und historische Backup-Ziele. Bestehende Server behalten ihren Direktzugriff;
   der Proxy ist zunächst ausgeschaltet.
2. Als Administrator oben **Proxy** öffnen und einen Server in der Grafik auswählen
   (alternativ **Server → Einstellungen → Subdomains und Direktzugriff**), dann
   die echten Subdomains eintragen, eine pro Zeile. Die erste ist die primäre
   Kopieradresse. Weitere Namen sind Aliase für denselben Server.
3. Falls ein bestehender Server den Direktport 25565 verwendet, dort einen anderen
   freien Direktport speichern, etwa 25566, oder seinen Direktzugriff deaktivieren.
   Dies erstellt den Minecraft-Container neu und unterbricht einen laufenden Server.
   Namen und Daten bleiben erhalten. Bei deaktiviertem Direktzugriff ist bis zur
   Proxy-Aktivierung kein öffentlicher Zugang vorhanden.
4. Unter **Proxy → Proxy und öffentliche Adresse einstellen** den Proxy aktivieren und speichern.
   Standard ist 25565/TCP. Ein belegter Port führt zu einer Fehlermeldung; das Panel
   verschiebt bestehende Server nicht automatisch.
5. Beim DNS-Anbieter für jede Subdomain einen **A-Eintrag** auf die öffentliche
   IPv4-Adresse des Hosts setzen. **AAAA** nur veröffentlichen, wenn der Host auch
   tatsächlich per IPv6 über diesen Port erreichbar ist. DNS stellt das Panel
   nicht selbst um. Bei einem Anbieter mit HTTP-Proxy muss dieser für die
   Minecraft-DNS-Einträge ausgeschaltet sein, sofern kein geeigneter TCP-Dienst
   verwendet wird.
6. Im Internetrouter/der Firewall den gemeinsamen **TCP-Port** zum Docker-Host
   freigeben. Bei Port 25565 geben Spieler nur die Subdomain ein. Bei einem anderen
   Port lautet die Adresse beispielsweise `survival.example.de:25570`.

Eigene Direktports können parallel aktiv bleiben. Sind Proxy und Direktzugriff
für einen Server aus, zeigt das Panel „Kein öffentlicher Zugang“ an.
**Öffentlicher Host für Direktverbindungen** ist im Panel bearbeitbar und hat
Vorrang vor `PUBLIC_HOST` aus der Umgebung.

## Zentrale Proxy-Übersicht

Der Admin-Tab **Proxy** zeigt die interaktive Zuordnung **Subdomain → Proxy → Server**.
Die Suche filtert nach Name, Subdomain oder Direktport. Nach Auswahl eines Servers
lassen sich dessen Subdomains bearbeiten und Verbindungsadressen kopieren.
Die Übersicht aktualisiert sich alle 15 Sekunden; ungespeicherte Eingaben bleiben erhalten.

Die Porttabelle unterscheidet tatsächliche Docker-Portbindungen am Host von den
benötigten Router-Freigaben. Gestoppte Container, nur lokal gebundene Ports und
Docker-Abfragefehler werden gesondert angezeigt. Interne Container-Ports ohne
Hostbindung zählen nicht als öffentlich. Zusätzliche veröffentlichte UDP-Ports
erscheinen ebenfalls, gehören aber nicht zum normalen Minecraft-Java-Proxyzugang.
DNS, Router und externe Firewall werden dadurch nicht geprüft.

## Betrieb mit Compose und Unraid

Der Router wird durch das Backend über dessen vorhandenen Docker-Zugang erstellt,
nicht als zusätzlicher Prozess im Panel. Das gilt sowohl für `docker-compose.yml`
als auch für das Alles-in-einem-Abbild/Unraid. Kein zweites manuelles Router-Service
mit demselben Namen anlegen.

- Router und Minecraft-Container liegen im konfigurierten `DOCKER_NETWORK`.
- Das Backend muss ebenfalls in diesem Netz liegen, damit die Erreichbarkeitsprüfung
  funktioniert. Beim Compose-Stack ist das bereits eingestellt; bei Unraid beide
  Panel- und Spielcontainer im gleichen benutzerdefinierten Bridge-Netz betreiben.
- `HOST_DATA_ROOT` ist der absolute Datenpfad aus Sicht des Docker-Hosts. In Compose
  kann er leer bleiben; das Backend ermittelt ihn aus dem eigenen `/data`-Mount.
- `<HOST_DATA_ROOT>/proxy` wird ausschließlich lesbar nach `/routes` eingebunden.
  Die Routendatei erzeugt das Panel aus der Datenbank. Manuelle Änderungen werden
  überschrieben. Der Router bekommt weder Docker-Socket noch Verwaltungs-API.
- `unless-stopped` startet den Router nach einem Ausfall neu. Beim Panel-Start wird
  der konfigurierte Zustand abgeglichen. Aliasänderungen ersetzen die Routendatei
  atomar und lösen anschließend `SIGHUP` zum Neuladen aus.
- Unbekannte Hostnamen haben kein Standardziel und werden abgewiesen. Ein gestoppter
  Minecraft-Server wird durch einen Verbindungsversuch nicht automatisch gestartet.
- Beim Abschalten des Proxys wird nur dessen eigener Container entfernt. Prüfen,
  dass benötigte Direktzugänge vorher aktiv sind. Deaktivierte Direktports bleiben
  dem jeweiligen Server in der Datenbank reserviert; der Proxy darf den freigegebenen
  Hostport dennoch nutzen.

## Diagnose und Grenzen

1. **DNS:** Löst die eingegebene Subdomain auf die erwartete öffentliche IP auf?
2. **Router:** Zeigt das Panel „Proxy erreichbar“? Das prüft Containerzustand und
   TCP-Verbindung vom Backend, nicht DNS oder die externe Portfreigabe.
3. **Route:** Ist der Name diesem Server zugeordnet? Namen werden normalisiert,
   weltweit innerhalb dieses Panels eindeutig gespeichert und dürfen weder
   Wildcards noch Protokoll oder Port enthalten.
4. **Minecraft:** Läuft der Zielserver vollständig? Serverlisten-Ping und tatsächlicher
   Login müssen mit der gewünschten Subdomain geprüft werden.

Minecraft-Authentifizierung bleibt am Zielserver; `online-mode` nicht für den Router
abschalten. Dieser Aufbau ist kein Velocity-/BungeeCord-Netzwerk mit Lobby oder
Serverwechseln. Ohne zusätzliche Unterstützung sieht ein Backend die Router-IP;
IP-basierte Sperren, Limits und Plugins sind entsprechend zu prüfen. Bedrock/UDP
und zusätzliche Mod-Ports (etwa Voice-Chat) werden nicht von dieser TCP-Route erfasst.

## Stand der Prüfung

Automatisiert geprüft sind Hostnamen/API/Eindeutigkeit, Docker-Konfiguration mit
Ersatzdienst und das offizielle Router-Binary gegen zwei lokale TCP-Testbackends:
Status-/Login-Handshake, zwei Namen plus Alias, Forge-Hostnamensuffix, unbekannte
Namen und atomarer Routenwechsel. Die Browserprüfung nutzt eine isolierte
PostgreSQL-Datenbank und eine simulierte Docker-API.

**Vor Produktion noch offen:** echte Container-Builds, ein vollständiger Login mit
Vanilla/Paper und dem tatsächlich verwendeten Fabric-/Forge-/NeoForge-Pack,
externe DNS-/Firewall-Erreichbarkeit sowie Router-/Panel-Neustart mit Spielern.
Die Entwicklungsumgebung hat keinen Zugriff auf den echten Docker-Socket.

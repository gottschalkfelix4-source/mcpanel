# Nodes – Minecraft-Server auf weiteren Rechnern

Mit Nodes laufen Minecraft-Server nicht nur auf dem Rechner mit dem Panel,
sondern auch auf weiteren Linux-Rechnern: einem gemieteten VPS oder einem
zweiten PC im Heimnetz. Das Panel bleibt die einzige Oberfläche: Konsole,
Dateimanager, Backups, Modpacks und Automationen funktionieren für Server auf
einer Node genauso wie für lokale.

## Einrichten

1. **Panel → Nodes → Node hinzufügen**
2. Name und Adresse eintragen und die Verbindungsart wählen:
   - **Über WireGuard (Standard)** – für Rechner im Internet. Adresse ist die
     öffentliche IP oder der DNS-Name des VPS.
   - **Im selben Netzwerk (ohne VPN)** – für Rechner im eigenen LAN. Adresse
     ist die feste private IPv4-Adresse der Node (z. B. `192.168.1.50`, am
     besten im Router fest vergeben).
3. Den angezeigten **einen Befehl** per SSH als root (oder mit sudo) auf der
   Node ausführen. Er installiert bei Bedarf Docker, legt das Profil unter
   `/opt/mcpanel-node/node.json` ab und startet den Container `mcpanel-node`.
4. Der Assistent wartet, bis sich die Node meldet, und zeigt dann CPU, RAM und
   Platte an.

Voraussetzungen auf der Node: Linux mit Docker-Unterstützung (Debian, Ubuntu,
Fedora, Alpine …). Für WireGuard bevorzugt ein Kernel mit WireGuard-Modul (ab
5.6 Standard), sonst nimmt der Agent `wireguard-go`.

## Windows-Nodes (Docker Desktop)

Im Assistenten **Windows** wählen. Statt eines Shell-Befehls gibt es dann einen
**PowerShell-Einzeiler** (`iex …`).

1. Docker Desktop installieren und starten, mit Linux-Containern (Standard) und
   Docker Engine 26 oder neuer: `winget install -e --id Docker.DockerDesktop`.
2. **PowerShell als Administrator** öffnen (Rechtsklick auf Start → „Terminal
   (Administrator)“) und den Befehl einfügen. Ohne Administratorrechte läuft
   alles außer den Firewall-Regeln, das Skript sagt dann Bescheid.
3. In den Einstellungen von Docker Desktop „Start Docker Desktop when you sign
   in“ einschalten: ohne laufendes Docker Desktop ist die Node getrennt.

Unterschiede zu Linux:

- Docker Desktop kennt kein Host-Netz. Der Agent läuft im Minecraft-Netz der
  Node, Docker Desktop veröffentlicht seine Ports am Windows-PC.
- **Ohne VPN** liegen die Agent-Ports auf 24375 (Docker), 24480 (Zustand),
  24481 (RCON) und 24445 (Samba). Port 445 ist unter Windows die eigene
  Dateifreigabe. Die Firewall-Regel „MCPanel Node Agent“ erlaubt sie nur aus
  dem lokalen Subnetz.
- **Mit VPN** wird nur UDP 51820 veröffentlicht. Im Router muss dieser Port
  (und die Spielports) auf den PC zeigen.
- Die Serverdaten liegen im Docker-Volume `mcpanel-node-data`, nicht auf einem
  Windows-Laufwerk: Minecraft über Bind-Mounts von NTFS wäre spürbar langsam.
  Das Panel sieht die Daten wie bei Linux über die Samba-Freigabe des Agenten.
- Firewall-Regeln heißen „MCPanel Node …“ und werden bei jeder Installation
  neu angelegt.

Entfernen (PowerShell):

```powershell
docker rm -f mcpanel-node; Get-NetFirewallRule -DisplayName 'MCPanel Node*' | Remove-NetFirewallRule
```

Die Daten bleiben im Volume. `docker volume rm mcpanel-node-data` löscht sie
endgültig.

## Server anlegen und umziehen

- **Anlegen:** Sobald es Nodes gibt, fragt die Serveranlage nach der Node.
  „Automatisch“ nimmt die verbundene Node mit dem meisten noch nicht
  zugewiesenen Arbeitsspeicher (Summe der Container-Grenzen).
- **Umziehen:** Server → Einstellungen → **Node**. Das Panel stoppt den Server,
  kopiert die Dateien auf das Ziel, prüft Anzahl und Größe, legt den Container
  dort neu an und startet ihn wieder. Erst danach verschwinden die alten
  Dateien. Scheitert der Umzug vorher, läuft der Server an der alten Stelle
  weiter.
- **Spieleradresse:** Server auf einer Node erreicht man unter der Adresse der
  Node und dem Spielport. Subdomains des Minecraft-Proxys leitet der Proxy auf
  dem Hauptserver automatisch weiter.

## Wie es funktioniert

```
Panel (Hauptserver)                                   Node
  ├─ Docker-API   ──── Token ──────────────►  mcpanel-node: Docker-Socket-Proxy (:2375)
  ├─ Zustand      ──── Token ──────────────►  mcpanel-node: /status (:7480)
  ├─ Dateien      ──── SMB3 ───────────────►  mcpanel-node: Samba (:445) → /opt/mcpanel-node
  └─ RCON         ──── Token ──────────────►  mcpanel-node: RCON-Weiterleitung (:7481) → mc-<id>:25575
           └─ alles über WireGuard (10.66.0.0/24) oder direkt im LAN
              (Windows ohne VPN: 24375/24480/24481/24445 am PC)
```

- Das Panel hängt das Datenverzeichnis jeder Node unter `<data>/nodes/<id>` ein.
  Dateimanager, Backups, Modpacks und SFTP arbeiten deshalb ohne Unterschied.
  Backups landen weiterhin auf dem Hauptserver.
- **WireGuard:** Das Panel wählt sich zur Node ein. Der Hauptserver braucht
  deshalb **keinen offenen Port**, auch hinter einem Heimrouter nicht. Auf der
  Node muss UDP 51820 (einstellbar) offen sein, dazu die Spielports.
- **Ohne VPN:** Der Agent lauscht auf der LAN-IP und nimmt nur private Adressen
  an. Docker-API, Zustandsabfrage und RCON-Weiterleitung verlangen das Token,
  Samba ein Kennwort und SMB3-Verschlüsselung. Docker-Steuerung und RCON gehen
  unverschlüsselt durchs LAN, deshalb nur in vertrauenswürdigen Netzen verwenden.
- **RCON** der Minecraft-Server wird auf Nodes nicht veröffentlicht. Das Panel
  verbindet sich mit der RCON-Weiterleitung des Agenten. Die nimmt nur
  Container an, die das Panel angelegt hat.
- Ist eine Node getrennt, zeigen ihre Server „Node getrennt“. Operationen an
  ihnen lehnt das Panel ab, statt halbe Zustände zu erzeugen. Autostart-Server
  starten, sobald die Node wieder verbunden ist.

## Rechte des Panel-Containers

| Recht | Wofür |
|---|---|
| `SYS_ADMIN`, `DAC_READ_SEARCH` | Freigaben der Nodes per CIFS einhängen (wie bei der Samba-Zweitablage) |
| `NET_ADMIN` | nur für WireGuard-Nodes: Tunnel-Schnittstelle im Panel-Container |

Compose-File und Unraid-Template enthalten alle drei. Fehlt `NET_ADMIN`, zeigt
die Nodes-Seite das an. Nodes im selben Netz funktionieren auch ohne.

Das Tunnelnetz ist `10.66.0.0/24`. Kollidiert es mit einem vorhandenen Netz:
`NODE_TUNNEL_SUBNET=10.77.0.0/24` setzen (nur /24).

## Entfernen

Nodes → Node → **Entfernen** (nur ohne Server). Danach auf der Node:

```sh
docker rm -f mcpanel-node; ip link del wg-mcpanel 2>/dev/null; rm -f /opt/mcpanel-node/node.json
```

Die Serverdaten unter `/opt/mcpanel-node/servers` bleiben liegen.

## Fehlersuche

- `docker logs mcpanel-node` auf der Node zeigt, was der Agent tut. „Bereit“
  heißt: er wartet auf das Panel.
- **Kein Tunnel-Handschlag:** UDP-Port der Node prüfen, auch in der Firewall
  des Anbieters.
- **Agent lehnt das Token ab:** Installationsbefehl aus dem Panel erneut
  ausführen (Nodes → Installationsbefehl). Das ist unschädlich.
- **Ohne VPN nicht erreichbar:** TCP 2375, 7480 und 445 müssen auf der Node
  aus dem LAN erreichbar sein. Das Skript öffnet sie bei ufw/firewalld selbst.

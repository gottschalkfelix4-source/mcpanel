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
  └─ RCON         ─────────────────────────►  mc-<id>: 25575 → <Node-Adresse>:<Spielport+10000>
           └─ alles über WireGuard (10.66.0.0/24) oder direkt im LAN
```

- Das Panel hängt das Datenverzeichnis jeder Node unter `<data>/nodes/<id>` ein.
  Dateimanager, Backups, Modpacks und SFTP arbeiten deshalb ohne Unterschied.
  Backups landen weiterhin auf dem Hauptserver.
- **WireGuard:** Das Panel wählt sich zur Node ein. Der Hauptserver braucht
  deshalb **keinen offenen Port**, auch hinter einem Heimrouter nicht. Auf der
  Node muss UDP 51820 (einstellbar) offen sein, dazu die Spielports.
- **Ohne VPN:** Der Agent lauscht auf der LAN-IP und nimmt nur private Adressen
  an. Docker-API und Zustandsabfrage verlangen das Token, Samba ein Kennwort
  und SMB3-Verschlüsselung. Docker-Steuerung und RCON gehen unverschlüsselt
  durchs LAN, deshalb nur in vertrauenswürdigen Netzen verwenden.
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

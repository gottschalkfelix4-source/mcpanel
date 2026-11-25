# HTTPS für das Panel

Das Panel selbst stellt nur HTTP bereit – für den vollen Funktionsumfang gehört
ein Reverse-Proxy mit Zertifikat davor:

- **Push-Benachrichtigungen** (Web-Push, *Mein Konto*) funktionieren nur über
  HTTPS oder `localhost` – der Browser verlangt das für Service Worker und
  `pushManager`.
- **Service Worker** (Offline-Hülle, Install-Prompt) läuft ebenfalls nur über
  HTTPS.
- Wer das Panel aus dem Internet erreicht, sollte ohnehin nicht nackt surfen.

**Sicherheit zuerst:** Ein aus dem Internet erreichbares Panel ist ein Panel am
Docker-Socket – wer die Anmeldung überwindet, kann Container anlegen. Für den
Zugriff von unterwegs ist ein VPN (WireGuard, Tailscale) einer Portfreigabe
klar vorzuziehen. HTTPS schützt die Leitung, nicht die Tür.

---

## Die Grundidee

Alle Varianten laufen gleich ab: ein Proxy hört auf Port 443, hat ein
Zertifikat (automatisch per Let’s Encrypt) und reicht Anfragen an das Panel
durch. Welcher Port das Panel intern ist:

| Betrieb | Panel-URL ohne Proxy |
|---|---|
| Compose-Stack (`docker compose`) | `http://<host>:8080` (nginx-Container, env `PANEL_PORT`) |
| Alles-in-einem-Abbild (Unraid/Synology) | `http://<host>:8080` |

Wichtig für die Einrichtung:

1. **`PUBLIC_HOST`** auf den öffentlichen Hostnamen setzen (im Compose-Stack
   per `.env`, im Alles-in-einem über die Container-Umgebung), z. B.
   `PUBLIC_HOST=mcpanel.example.com` – sonst zeigt das Panel `localhost`-Adressen.
2. **`TRUSTED_PROXIES`** auf die Adresse des Reverse-Proxys setzen (nur
   Compose-Stack; kommagetrennt, Adresse oder CIDR). Das Panel glaubt
   `X-Forwarded-For` nur von dort – sonst könnte jeder Besucher seine Adresse
   frei wählen und die Anmeldebremse umgehen.
3. **WebSocket** durchreichen: `/socket.io` braucht die Upgrade-Header.
4. **Große Dateien**: Downloads (Backups, Welten) und Uploads brauchen
   großzügige `client_max_body_size` (z. B. 0 = unbegrenzt) und lange Timeouts.

---

## Variante 1: Caddy (am einfachsten)

Caddy holt Zertifikate automatisch und kann WebSockets ohne Sonderkonfiguration.

`Caddyfile` (wenn das Panel auf demselben Rechner auf Port 8080 läuft):

```
mcpanel.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Start (z. B. als Container):

```sh
docker run -d --name caddy -p 80:80 -p 443:443 \
  -v caddy-data:/data -v $PWD/Caddyfile:/etc/caddy/Caddyfile \
  caddy:2
```

In einem `docker-compose`-Netz (Proxy als Dienst neben dem Panel) genügt statt
`127.0.0.1:8080` der Dienstname, z. B. `reverse_proxy frontend:80`.

## Variante 2: nginx + certbot

Block für die Site (`/etc/nginx/sites-available/mcpanel`):

```nginx
server {
    listen 443 ssl http2;
    server_name mcpanel.example.com;

    ssl_certificate     /etc/letsencrypt/live/mcpanel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcpanel.example.com/privkey.pem;

    client_max_body_size 0;  # Backups/Welten herunter- und hochladen

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Socket.IO: WebSocket-Verbindungen durchreichen
    location /socket.io/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}

server {
    listen 80;
    server_name mcpanel.example.com;
    return 301 https://$host$request_uri;
}
```

Zertifikat besorgen und erneuern:

```sh
certbot certonly --webroot -w /var/www/html -d mcpanel.example.com
# Erneuerung automatisch über certbot.timer; nginx danach neu laden.
```

## Variante 3: Unraid / NAS

- **Unraid**: Nginx Proxy Manager (Community Applications) – Host `127.0.0.1`,
  Port `8080`, „Block Common Exploits“ und „Websockets Support“ aktivieren,
  SSL-Zertifikat „Let’s Encrypt“ anfordern.
- Alternativ **SWAG** (LinuxServer) mit dem vorgefertigten Proxy-Beispiel für
  generische Web-Apps – WebSocket-Ort einstellen.
- **Synology**: „Reverse Proxy“ unter Systemsteuerung → Anmeldeportal, Ziel
  `http://127.0.0.1:8080`; Zertifikat in Systemsteuerung → Sicherheit.

## Variante 4: Tailscale (Heimnetz- und Unterwegs-Alternative)

Wer kein eigenes Zertifikat will, kann Tailscale nutzen: der MagicDNS-Name
(`https://<host>.ts.net`) ist automatisch HTTPS-fähig und das Panel bleibt
trotzdem nur im eigenen Tailnet erreichbar:

```sh
tailscale cert <host>
tailscale serve --bg --https 443 http://127.0.0.1:8080
```

---

## Nach dem Umstieg

- Die **Panel-Adresse** in *Einstellungen → Systemkonfiguration* (bzw. über
  `PUBLIC_HOST`) auf die neue HTTPS-URL stellen – Downloads mit Kurzzeit-Token
  und SFTP-Hinweise zeigen diese Adresse.
- **SFTP** (Port 2222) bleibt ein eigener Dienst und wird **nicht** über den
  Proxy geleitet – der Port muss weiterhin separat freigegeben sein, wenn SFTP
  von außen genutzt werden soll.
- Angemeldete Sitzungen bleiben gültig; wer auf einem neuen Hostnamen
  zugreift, meldet sich ggf. neu an (Token ist an keine Domain gebunden).
- Push-Benachrichtigungen lassen sich jetzt unter *Mein Konto* aktivieren.

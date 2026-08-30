# ---------------------------------------------------------------------------
# Alles-in-einem-Abbild: PostgreSQL, Backend und Weboberfläche in einem
# Container.
#
# Der Compose-Stack im Projektwurzelverzeichnis ist die Variante für Server,
# auf denen man mehrere Container betreiben will. Unraid, Synology & Co.
# starten aus ihren Oberflächen aber genau *einen* Container je Anwendung –
# dafür ist dieses Abbild da.
# ---------------------------------------------------------------------------

# --- Weboberfläche bauen ---------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# --- Backend bauen ---------------------------------------------------------
FROM node:22-alpine AS backend
WORKDIR /build
RUN apk add --no-cache openssl openssl-dev libc6-compat
COPY backend/package*.json ./
RUN npm install
COPY backend/prisma ./prisma
RUN npx prisma generate
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npx tsc -p tsconfig.json

# --- Laufzeit --------------------------------------------------------------
FROM node:22-alpine

# postgresql: die Datenbank läuft im selben Container
# nginx:      liefert die Oberfläche aus und reicht /api weiter
# cifs-utils: für die Samba-Zweitablage der Backups
# su-exec:    Postgres darf nicht als root laufen
RUN apk add --no-cache \
      postgresql16 postgresql16-contrib \
      nginx \
      tar curl tzdata openssl openssl-dev libc6-compat cifs-utils su-exec

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY backend/prisma ./prisma
RUN npx prisma generate

COPY --from=backend /build/dist ./dist
COPY --from=frontend /build/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# /data  – Serverdaten, Backups, Datenbank
# Der Pfad muss auf dem Host derselbe sein wie im Container, weil die
# Minecraft-Container ihre Verzeichnisse per Bind-Mount vom Host bekommen.
VOLUME ["/data"]

# HOST_DATA_ROOT wird bewusst NICHT gesetzt: das Panel liest den Host-Pfad
# beim Start aus seinen eigenen Mounts. Ein fester Wert hier würde die
# Erkennung aushebeln – die Minecraft-Container würden dann versuchen, einen
# Pfad einzuhängen, den es auf dem Host gar nicht gibt.
ENV NODE_ENV=production \
    DATA_ROOT=/data \
    PGDATA=/data/postgres \
    PORT=3000 \
    TZ=Europe/Berlin

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]

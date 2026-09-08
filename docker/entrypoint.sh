#!/bin/sh
# ---------------------------------------------------------------------------
# Start des Alles-in-einem-Abbilds: PostgreSQL, Backend, nginx.
#
# Bewusst ohne Prozess-Supervisor: drei Dienste, feste Startreihenfolge, und
# faellt einer aus, soll der ganze Container neu starten statt halb zu laufen.
# Das uebernimmt die Neustart-Regel von Docker beziehungsweise Unraid.
# ---------------------------------------------------------------------------
set -e

DATA_ROOT="${DATA_ROOT:-/data}"
PGDATA="${PGDATA:-$DATA_ROOT/postgres}"
PGUSER=postgres
DB_NAME="${POSTGRES_DB:-mcpanel}"

log() { echo "[mcpanel] $*"; }

mkdir -p "$DATA_ROOT/servers" "$DATA_ROOT/backups" "$DATA_ROOT/cache"

# --- PostgreSQL ------------------------------------------------------------
mkdir -p "$PGDATA" /run/postgresql
chown -R postgres:postgres "$PGDATA" /run/postgresql
chmod 700 "$PGDATA"

# Bei einem Update kommt eine neue Abbild-Fassung auf ein bestehendes
# Datenverzeichnis. Passt die PostgreSQL-Hauptversion nicht mehr dazu,
# startet die Datenbank nicht - dann lieber hier verstaendlich abbrechen als
# den Nutzer mit "database files are incompatible" allein zu lassen.
if [ -f "$PGDATA/PG_VERSION" ]; then
  VORHANDEN=$(cat "$PGDATA/PG_VERSION")
  # "postgres (PostgreSQL) 16.4" -> "16"
  INSTALLIERT=$(su-exec postgres postgres --version | awk '{print $3}' | cut -d. -f1)
  if [ -n "$INSTALLIERT" ] && [ "$VORHANDEN" != "$INSTALLIERT" ]; then
    log "ABBRUCH: Die Daten stammen von PostgreSQL $VORHANDEN, im Abbild steckt $INSTALLIERT."
    log "Ein Wechsel der Hauptversion braucht pg_upgrade oder eine Sicherung."
    log "Bitte vorher ein Backup ziehen und die Hinweise zur Aktualisierung lesen."
    exit 1
  fi
fi

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  log "Datenbank wird angelegt ..."
  su-exec postgres initdb -D "$PGDATA" -E UTF8 --locale=C >/dev/null
  # Nur ueber den lokalen Socket erreichbar - die Datenbank verlaesst den
  # Container nicht, deshalb braucht es kein Passwort und keinen Port.
  echo "listen_addresses = ''" >> "$PGDATA/postgresql.conf"
fi

log "PostgreSQL startet ..."
su-exec postgres pg_ctl -D "$PGDATA" -o "-k /run/postgresql" -w -t 60 start

if ! su-exec postgres psql -tAc "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1; then
  log "Lege Datenbank \"$DB_NAME\" an"
  su-exec postgres createdb "$DB_NAME"
fi

export DATABASE_URL="postgresql://$PGUSER@localhost/$DB_NAME?host=/run/postgresql"

# --- Aufraeumen beim Beenden ----------------------------------------------
stop() {
  log "Fahre herunter ..."
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null || true
  nginx -s quit 2>/dev/null || true
  su-exec postgres pg_ctl -D "$PGDATA" -m fast -w -t 30 stop 2>/dev/null || true
  exit "${1:-0}"
}
NODE_PID=''
trap 'stop 0' TERM INT

# --- Backend ---------------------------------------------------------------
log "Schema wird abgeglichen ..."
npx prisma db push --skip-generate >/dev/null

log "Backend startet ..."
node dist/index.js &
NODE_PID=$!

# Warten, bis das Backend antwortet - nginx soll nicht mit 502 begruessen.
i=0
while [ $i -lt 60 ]; do
  if curl -fsS "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null 2>&1; then
    break
  fi
  # Ist der Node-Prozess weg, hat der Start nicht geklappt.
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    log "Backend konnte nicht starten"
    stop 1
  fi
  i=$((i + 1))
  sleep 1
done

# --- Weboberflaeche --------------------------------------------------------
log "Weboberflaeche auf Port 8080"
nginx -g 'daemon off;' &
NGINX_PID=$!
POSTGRES_PID=$(head -n 1 "$PGDATA/postmaster.pid")

# Every critical process must stay alive; Docker health alone does not restart it.
while kill -0 "$NODE_PID" 2>/dev/null && kill -0 "$NGINX_PID" 2>/dev/null && kill -0 "$POSTGRES_PID" 2>/dev/null; do
  sleep 2 &
  wait $! || true
done
log "Ein kritischer Dienst wurde beendet"
stop 1

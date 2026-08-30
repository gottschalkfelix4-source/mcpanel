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
  exit 0
}
trap stop TERM INT

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
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

# --- Weboberflaeche --------------------------------------------------------
log "Weboberflaeche auf Port 8080"
nginx

# Solange das Backend laeuft, laeuft der Container.
wait "$NODE_PID"

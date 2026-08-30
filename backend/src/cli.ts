/**
 * Kleines Wartungswerkzeug für den Notfall – gedacht für
 *
 *   docker exec mcpanel node dist/cli.js …
 *
 * Ohne das gäbe es keinen Weg zurück, wenn niemand mehr ins Panel kommt: die
 * Anmeldung ist die einzige Tür, und ein Passwort lässt sich nur im Panel
 * ändern. Die Befehle laufen bewusst nur auf dem Server, wo ohnehin schon
 * root-Rechte nötig sind.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import bcrypt from 'bcryptjs';

// Im Alles-in-einem-Abbild setzt erst das Startskript die Adresse der
// Datenbank; ein "docker exec" erbt sie nicht. Deshalb hier dieselbe Vorgabe,
// bevor der Prisma-Client geladen wird.
if (!process.env.DATABASE_URL) {
  const db = process.env.POSTGRES_DB ?? 'mcpanel';
  process.env.DATABASE_URL = `postgresql://postgres@localhost/${db}?host=/run/postgresql`;
}

const { prisma } = await import('./db.js');

const ausfuehren = promisify(execFile);

const [command, ...args] = process.argv.slice(2);

function hilfe(): never {
  console.log(`
MCPanel – Wartungsbefehle

  node dist/cli.js benutzer
      Listet alle Konten mit Rolle und Zustand auf.

  node dist/cli.js passwort <Benutzername|E-Mail> <neues Passwort>
      Setzt das Passwort eines Kontos neu. Mindestens 8 Zeichen.

  node dist/cli.js admin <Benutzername|E-Mail>
      Macht ein Konto zum Administrator.

  node dist/cli.js aktivieren <Benutzername|E-Mail>
      Hebt eine Deaktivierung wieder auf.

  node dist/cli.js sicherung [Zieldatei]
      Schreibt die Panel-Datenbank mit pg_dump in eine Datei.
      Ohne Angabe unter <Datenverzeichnis>/backups/panel/.

  node dist/cli.js einspielen <Datei> --ja
      Spielt eine solche Sicherung zurueck und ersetzt dabei den
      gesamten Inhalt der Datenbank. Nur mit --ja.
`);
  process.exit(command ? 1 : 0);
}

async function finde(kennung: string) {
  const user = await prisma.user.findFirst({
    where: { OR: [{ username: kennung }, { email: kennung.toLowerCase() }] },
  });
  if (!user) {
    console.error(`Kein Konto gefunden für "${kennung}".`);
    process.exit(1);
  }
  return user;
}

interface Verbindung {
  /** -h/-p/-U/-d, so wie pg_dump, pg_restore und psql sie gleichermaßen nehmen. */
  args: string[];
  env: NodeJS.ProcessEnv;
  datenbank: string;
}

/**
 * Zerlegt DATABASE_URL in Argumente für die PostgreSQL-Werkzeuge.
 *
 * Im Alles-in-einem-Abbild lauscht die Datenbank nur auf einem Unix-Socket
 * (`?host=/run/postgresql`, Benutzer `postgres`, ohne Passwort), im
 * Compose-Stack steht sie als eigener Container mit Passwort in der Adresse.
 * Beides landet hier in derselben Argumentliste.
 */
function verbindung(): Verbindung {
  let url: URL | null = null;
  try {
    url = new URL(process.env.DATABASE_URL ?? '');
  } catch {
    /* Meldung folgt unten */
  }
  if (!url) {
    console.error('DATABASE_URL ist nicht gesetzt oder keine gültige Adresse.');
    process.exit(1);
  }

  const datenbank = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!datenbank) {
    console.error('In DATABASE_URL fehlt der Name der Datenbank.');
    process.exit(1);
  }

  const host = url.searchParams.get('host') ?? url.hostname;
  const benutzer = decodeURIComponent(url.username);
  const passwort = decodeURIComponent(url.password);

  const args: string[] = [];
  if (host) args.push('-h', host);
  if (url.port) args.push('-p', url.port);
  if (benutzer) args.push('-U', benutzer);
  args.push('-d', datenbank);

  return {
    args,
    // Das Passwort gehört nicht auf die Kommandozeile - dort läse es jedes
    // "ps" mit. Die pg_*-Werkzeuge nehmen es aus PGPASSWORD.
    env: passwort ? { ...process.env, PGPASSWORD: passwort } : process.env,
    datenbank,
  };
}

/** Ruft eines der PostgreSQL-Werkzeuge auf und bricht bei Fehlern ab. */
async function pgWerkzeug(programm: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const { stderr } = await ausfuehren(programm, args, { env });
    const hinweise = stderr.trim();
    if (hinweise) console.error(hinweise);
  } catch (err) {
    const fehler = err as NodeJS.ErrnoException & { stderr?: string };
    if (fehler.code === 'ENOENT') {
      console.error(`"${programm}" gibt es in diesem Container nicht.`);
      console.error('Im Compose-Stack liegt die Datenbank in einem eigenen Container – dort ist das Werkzeug vorhanden:');
      console.error(`  docker compose exec -T db ${programm} …`);
      process.exit(1);
    }
    console.error(fehler.stderr?.trim() || fehler.message);
    process.exit(1);
  }
}

/** Erkennt am Kopf der Datei, ob sie aus "pg_dump --format=custom" stammt. */
function istEigenformat(datei: string): boolean {
  const kopf = Buffer.alloc(5);
  const fd = fs.openSync(datei, 'r');
  try {
    fs.readSync(fd, kopf, 0, 5, 0);
  } finally {
    fs.closeSync(fd);
  }
  return kopf.toString('latin1') === 'PGDMP';
}

/** Vorgabe-Ziel einer Sicherung, wenn keines angegeben wurde. */
function standardZiel(): string {
  // Nicht über config.ts: das Modul legt beim Laden ein Sitzungs-Geheimnis an,
  // und das hat ein Wartungsbefehl nicht zu tun.
  const datenVerzeichnis = process.env.DATA_ROOT ?? path.resolve(process.cwd(), 'data');
  const stempel = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  return path.join(datenVerzeichnis, 'backups', 'panel', `panel-${stempel}.dump`);
}

switch (command) {
  case 'benutzer': {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    if (users.length === 0) {
      console.log('Noch keine Konten – das Panel zeigt beim Aufruf die Ersteinrichtung.');
      break;
    }
    for (const u of users) {
      console.log(
        `${u.username.padEnd(20)} ${u.email.padEnd(32)} ${u.role.padEnd(6)} ${
          u.active ? 'aktiv' : 'deaktiviert'
        }`,
      );
    }
    break;
  }

  case 'passwort': {
    const [kennung, passwort] = args;
    if (!kennung || !passwort) hilfe();
    if (passwort.length < 8) {
      console.error('Das Passwort braucht mindestens 8 Zeichen.');
      process.exit(1);
    }
    const user = await finde(kennung);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(passwort, 10) },
    });
    console.log(`Passwort für "${user.username}" gesetzt.`);
    break;
  }

  case 'admin': {
    const [kennung] = args;
    if (!kennung) hilfe();
    const user = await finde(kennung);
    await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    console.log(`"${user.username}" ist jetzt Administrator.`);
    break;
  }

  case 'aktivieren': {
    const [kennung] = args;
    if (!kennung) hilfe();
    const user = await finde(kennung);
    await prisma.user.update({ where: { id: user.id }, data: { active: true } });
    console.log(`"${user.username}" ist wieder aktiv.`);
    break;
  }

  case 'sicherung': {
    const [ziel] = args;
    const datei = path.resolve(ziel ?? standardZiel());
    const { args: verbindungsArgs, env, datenbank } = verbindung();
    try {
      fs.mkdirSync(path.dirname(datei), { recursive: true });
    } catch (err) {
      console.error(`Ordner für ${datei} lässt sich nicht anlegen: ${(err as Error).message}`);
      process.exit(1);
    }
    console.log(`Sichere "${datenbank}" nach ${datei} …`);
    // Eigenformat: komprimiert, und pg_restore kann daraus einzeln auswählen.
    await pgWerkzeug('pg_dump', [...verbindungsArgs, '--format=custom', '-f', datei], env);
    console.log(`Fertig – ${(fs.statSync(datei).size / 1024 / 1024).toFixed(1)} MB.`);
    console.log(
      'Darin stehen Konten, Rechte, RCON-Passwörter und die Zugangsdaten der Zweitablage –',
    );
    console.log('die Datei gehört nicht in eine offene Freigabe.');
    break;
  }

  case 'einspielen': {
    const [quelle] = args.filter((a) => a !== '--ja');
    if (!quelle) hilfe();
    const datei = path.resolve(quelle);
    if (!fs.existsSync(datei)) {
      console.error(`Datei nicht gefunden: ${datei}`);
      process.exit(1);
    }
    const { args: verbindungsArgs, env, datenbank } = verbindung();

    if (!args.includes('--ja')) {
      console.error(`Das ersetzt den gesamten Inhalt von "${datenbank}": Konten, Rechte,`);
      console.error('Automatisierungen und die Zuordnung der Server zu ihren Verzeichnissen.');
      console.error('Wenn das so gewollt ist, den Befehl mit --ja wiederholen:');
      console.error(`  node dist/cli.js einspielen ${quelle} --ja`);
      process.exit(1);
    }

    console.log(`Spiele ${datei} in "${datenbank}" ein …`);
    console.log('Läuft das Panel dabei, kann der Vorgang auf Tabellensperren warten.');
    if (istEigenformat(datei)) {
      // --clean/--if-exists räumen den alten Stand weg, -1 macht daraus eine
      // einzige Transaktion: bricht etwas ab, bleibt die Datenbank wie sie war.
      // --no-owner, weil der Besitzer im Abbild "postgres" heißt und im
      // Compose-Stack "mcpanel".
      await pgWerkzeug(
        'pg_restore',
        [...verbindungsArgs, '--clean', '--if-exists', '--no-owner', '-1', datei],
        env,
      );
    } else {
      // Kein Eigenformat: dann ist es eine SQL-Datei, die psql einliest.
      await pgWerkzeug('psql', [...verbindungsArgs, '-v', 'ON_ERROR_STOP=1', '-q', '-f', datei], env);
    }
    console.log('Eingespielt. Jetzt den Container neu starten, damit nichts auf dem alten Stand weiterarbeitet.');
    break;
  }

  default:
    hilfe();
}

await prisma.$disconnect();

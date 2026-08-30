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
import bcrypt from 'bcryptjs';

// Im Alles-in-einem-Abbild setzt erst das Startskript die Adresse der
// Datenbank; ein "docker exec" erbt sie nicht. Deshalb hier dieselbe Vorgabe,
// bevor der Prisma-Client geladen wird.
if (!process.env.DATABASE_URL) {
  const db = process.env.POSTGRES_DB ?? 'mcpanel';
  process.env.DATABASE_URL = `postgresql://postgres@localhost/${db}?host=/run/postgresql`;
}

const { prisma } = await import('./db.js');

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

  default:
    hilfe();
}

await prisma.$disconnect();

/**
 * Kontingente je Server.
 *
 * Die Grenzen hängen am Server, nicht am Konto: ein Server bekommt seinen
 * Platz, seinen Arbeitsspeicher und seine Zahl an Sicherungen zugeteilt, und
 * wer darauf eingeladen wird, arbeitet innerhalb dieser Grenzen. Angelegt und
 * zugeteilt wird nur von Administratoren.
 *
 * 0 bedeutet überall „unbegrenzt".
 */
import fsp from 'node:fs/promises';
import type { Server } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { computeDiskUsage, getDiskUsage } from './diskUsage.js';

export interface QuotaState {
  /** Obergrenze in Bytes, 0 = unbegrenzt */
  diskLimitBytes: number;
  diskUsedBytes: number;
  /** Auslastung in Prozent, null wenn unbegrenzt oder noch unbekannt */
  diskPercent: number | null;
  diskPending: boolean;
  backupLimit: number;
  backupCount: number;
  memoryLimitMb: number;
}

const MB = 1024 * 1024;

/** Zustand für die Anzeige – blockiert nicht, nutzt zwischengespeicherte Werte. */
export async function quotaState(server: Server): Promise<QuotaState> {
  const disk = getDiskUsage(server.id);
  const backupCount = await prisma.backup.count({ where: { serverId: server.id } });
  const limit = server.quotaDiskMb * MB;

  return {
    diskLimitBytes: limit,
    diskUsedBytes: disk.total,
    diskPercent: limit > 0 && !disk.pending ? Math.round((disk.total / limit) * 100) : null,
    diskPending: disk.pending,
    backupLimit: server.quotaBackups,
    backupCount,
    memoryLimitMb: server.quotaMemoryMb,
  };
}

/**
 * Wirft, wenn der Platz nicht mehr reicht. `extraBytes` ist der geschätzte
 * Zuwachs des geplanten Vorgangs.
 *
 * Gemessen wird hier bewusst frisch: eine Sicherung, die das Kontingent
 * sprengt, würde sonst erst beim nächsten Durchlauf auffallen – dann liegt
 * sie aber schon auf der Platte.
 */
export async function assertDiskAvailable(server: Server, extraBytes = 0): Promise<void> {
  if (server.quotaDiskMb <= 0) return;

  const limit = server.quotaDiskMb * MB;
  const disk = await computeDiskUsage(server.id);

  if (disk.total + extraBytes > limit) {
    const used = (disk.total / 1024 ** 3).toFixed(1);
    const max = (limit / 1024 ** 3).toFixed(1);
    throw badRequest(
      `Speicherkontingent erschöpft: ${used} GB von ${max} GB belegt. ` +
        'Alte Sicherungen löschen oder das Kontingent anheben.',
    );
  }
}

/**
 * Entfernt die ältesten Sicherungen, bis die erlaubte Zahl wieder eingehalten
 * ist. Gibt zurück, wie viele entfernt wurden.
 */
export async function pruneToBackupLimit(server: Server): Promise<number> {
  if (server.quotaBackups <= 0) return 0;

  const backups = await prisma.backup.findMany({
    where: { serverId: server.id },
    orderBy: { createdAt: 'desc' },
  });
  const surplus = backups.slice(server.quotaBackups);
  if (surplus.length === 0) return 0;

  const { deleteBackup } = await import('./backups.js');
  let removed = 0;
  for (const backup of surplus) {
    try {
      await deleteBackup(server, backup.id);
      removed++;
    } catch {
      /* eine fehlgeschlagene Löschung darf den laufenden Vorgang nicht kippen */
    }
  }
  return removed;
}

export interface VolumeSpace {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  /** Auslastung des Datenträgers in Prozent */
  usedPercent: number;
  /** Ab weniger freiem Platz gilt der Datenträger als knapp. */
  warnBytes: number;
  low: boolean;
}

/** Warnschwelle: 10 % des Datenträgers, mindestens aber so viele Bytes. */
const VOLUME_WARN_FLOOR = 5 * 1024 ** 3;

/**
 * Freier Platz auf dem Datenträger des Datenverzeichnisses – unabhängig von
 * allen Kontingenten.
 *
 * Dort liegen nicht nur Serverdaten, Sicherungen und der Modpack-Cache,
 * sondern auch das Datenverzeichnis von PostgreSQL. Läuft der Datenträger
 * voll, hält nicht bloß ein Kontingent nicht: die Datenbank steht, das Panel
 * ist weg, und ein laufendes tar bricht mitten im Archiv ab.
 *
 * Gewarnt wird beim strengeren der beiden Werte. 10 % allein greifen auf
 * kleinen Datenträgern zu spät – von 20 GB bleiben dann 2 GB, zu wenig für ein
 * einziges Modpack-Archiv –, die absoluten 5 GB auf großen. Es zählt daher der
 * jeweils höhere Schwellwert.
 *
 * `null`, wenn sich der Datenträger nicht auslesen lässt (etwa auf einem
 * Einhängepunkt, der statfs nicht beantwortet).
 */
export async function volumeSpace(): Promise<VolumeSpace | null> {
  try {
    const stat = await fsp.statfs(config.dataRoot);
    const blockSize = Number(stat.bsize);
    const totalBytes = blockSize * Number(stat.blocks);
    // bavail statt bfree: die für root reservierten Blöcke stehen dem Panel
    // nicht zur Verfügung.
    const freeBytes = blockSize * Number(stat.bavail);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;

    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const warnBytes = Math.max(totalBytes * 0.1, VOLUME_WARN_FLOOR);

    return {
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent: Math.round((usedBytes / totalBytes) * 100),
      warnBytes,
      low: freeBytes < warnBytes,
    };
  } catch {
    return null;
  }
}

/**
 * Prüft eine gewünschte Arbeitsspeichergröße. Administratoren dürfen über die
 * Grenze hinaus – sie setzen sie ja selbst.
 */
export function assertMemoryAllowed(server: Server, memoryMb: number, isAdmin: boolean): void {
  if (isAdmin || server.quotaMemoryMb <= 0) return;
  if (memoryMb > server.quotaMemoryMb) {
    throw badRequest(
      `Für diesen Server sind höchstens ${server.quotaMemoryMb} MB Arbeitsspeicher freigegeben.`,
    );
  }
}

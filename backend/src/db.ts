import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

// BigInt (Backup-Größen) JSON-serialisierbar machen
(BigInt.prototype as unknown as { toJSON(): string }).toJSON = function () {
  return this.toString();
};

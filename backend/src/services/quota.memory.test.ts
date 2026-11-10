import type { Server } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ prisma: {} }));
vi.mock('../config.js', () => ({ config: { dataRoot: '/data' } }));
vi.mock('./diskUsage.js', () => ({ computeDiskUsage: vi.fn(), getDiskUsage: vi.fn() }));

import { assertMemoryAllowed } from './quota.js';

const server = { memoryMb: 4096, quotaMemoryMb: 8192 } as Server;

describe('assertMemoryAllowed', () => {
  it('lässt Nicht-Admins den gespeicherten Wert unverändert zurückschicken', () => {
    expect(() => assertMemoryAllowed(server, 4096, false)).not.toThrow();
    // Auch wenn ein Admin den Wert über das Kontingent hinaus gesetzt hat.
    expect(() => assertMemoryAllowed({ ...server, quotaMemoryMb: 2048 }, 4096, false)).not.toThrow();
  });

  it('verbietet Nicht-Admins jede Änderung – auch innerhalb des Kontingents und nach unten', () => {
    for (const mb of [2048, 6144, 8192, 16384]) {
      expect(() => assertMemoryAllowed(server, mb, false)).toThrow(expect.objectContaining({ statusCode: 403 }));
    }
    expect(() => assertMemoryAllowed({ ...server, quotaMemoryMb: 0 }, 6144, false)).toThrow(/nur ein Administrator/);
  });

  it('lässt Administratoren den Arbeitsspeicher frei setzen', () => {
    expect(() => assertMemoryAllowed(server, 16384, true)).not.toThrow();
    expect(() => assertMemoryAllowed(server, 1024, true)).not.toThrow();
  });
});

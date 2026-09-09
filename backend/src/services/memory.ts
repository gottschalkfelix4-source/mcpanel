/** Start small and grow on demand; an explicit INIT_MEMORY still takes priority. */
export function defaultInitialMemory(maximum: string): string {
  const match = maximum.trim().match(/^(\d+)([kmgt]?)$/i);
  // Keep custom syntax (e.g. percentages) on the image's previous semantics.
  if (!match) return maximum;
  const power = { '': 0, k: 1, m: 2, g: 3, t: 4 }[match[2].toLowerCase()]!;
  const bytes = Number(match[1]) * 1024 ** power;
  return bytes > 2 * 1024 ** 3 ? '2048M' : maximum;
}

export interface DockerMemoryStats {
  usage?: number;
  limit?: number;
  stats?: { total_inactive_file?: number; inactive_file?: number; cache?: number };
}

/** Same working-set calculation as docker stats, plus the old Docker cache fallback. */
export function memoryWorkingSet(memory: DockerMemoryStats): number {
  const usage = Math.max(0, memory.usage ?? 0);
  const stats = memory.stats;
  const inactive = stats?.total_inactive_file ?? stats?.inactive_file ?? stats?.cache ?? 0;
  // Invalid/racing counters must not produce negative usage or hide all memory.
  return inactive >= 0 && inactive < usage ? usage - inactive : usage;
}

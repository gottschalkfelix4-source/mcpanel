interface Sample { since: number; warned: boolean }

/** Erst nach Anlaufzeit und wiederholtem Fehler warnen; Wiederholung unterdrücken. */
export class HealthMonitor {
  private failures = new Map<string, Sample>();
  observe(id: string, state: string, health: string | null, startedAt: string | null, now = Date.now()): 'failed' | 'recovered' | null {
    const previous = this.failures.get(id);
    if (state !== 'running') { this.failures.delete(id); return null; }
    if (health === 'healthy') {
      this.failures.delete(id);
      return previous?.warned ? 'recovered' : null;
    }
    if (health !== 'unhealthy') { this.failures.delete(id); return null; }
    const start = startedAt ? Date.parse(startedAt) : NaN;
    if (Number.isFinite(start) && now - start < 15 * 60_000) { this.failures.delete(id); return null; }
    const sample = previous ?? { since: now, warned: false };
    this.failures.set(id, sample);
    if (!sample.warned && now - sample.since >= 2 * 60_000) { sample.warned = true; return 'failed'; }
    return null;
  }
  retain(ids: Set<string>) { for (const id of this.failures.keys()) if (!ids.has(id)) this.failures.delete(id); }
}

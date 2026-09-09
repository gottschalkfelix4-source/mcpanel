import fs from 'node:fs';
import os from 'node:os';
import type Docker from 'dockerode';

/** Unraid starts MCPanel on bridge; RCON needs the servers' private network. */
export async function connectPanelToNetwork(docker: Docker, network: string): Promise<void> {
  if (!fs.existsSync('/.dockerenv')) return;
  const candidates = new Set<string>();
  for (const file of ['/proc/self/cgroup', '/proc/self/mountinfo']) {
    try {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/(?:docker[-/]|containers\/)([a-f0-9]{64})(?:\.scope|\/|\s|$)/g)) {
        candidates.add(match[1]);
      }
    } catch { /* Not every cgroup setup exposes container IDs. */ }
  }
  candidates.add(os.hostname());
  for (const candidate of candidates) {
    let self: Docker.ContainerInspectInfo;
    try {
      self = await docker.getContainer(candidate).inspect();
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) continue;
      throw error;
    }
    if (self.NetworkSettings.Networks[network]) return;
    try {
      await docker.getNetwork(network).connect({ Container: self.Id });
    } catch (error) {
      // Concurrent server creation can attach the same panel in the meantime.
      const current = await docker.getContainer(self.Id).inspect();
      if (!current.NetworkSettings.Networks[network]) throw error;
    }
    return;
  }
  throw new Error('Eigener Panel-Container nicht gefunden; Verbindung zum Minecraft-Netzwerk nicht möglich');
}

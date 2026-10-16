import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Stellt CHANGELOG.md aus der Projektwurzel als Modul `virtual:changelog`
 * bereit („Was ist neu“). Fehlt die Datei – etwa beim Compose-Bau, dessen
 * Kontext nur ./frontend umfasst –, bleibt der Text leer.
 */
function changelog(): Plugin {
  const id = 'virtual:changelog';
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');
  return {
    name: 'mcpanel-changelog',
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(resolved) {
      if (resolved !== `\0${id}`) return null;
      if (fs.existsSync(file)) this.addWatchFile(file);
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      return `export default ${JSON.stringify(text)};`;
    },
  };
}

export default defineConfig({
  plugins: [react(), changelog()],
  server: {
    port: 5173,
    proxy: {
      // Standard: der laufende Docker-Stack (nginx leitet ans Backend weiter).
      // Für ein lokal gestartetes Backend VITE_API_PROXY=http://localhost:3000 setzen.
      '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:8080', changeOrigin: true },
      '/socket.io': { target: process.env.VITE_API_PROXY ?? 'http://localhost:8080', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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

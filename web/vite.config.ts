import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
        reset: resolve(__dirname, 'src/reset.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Dev: forward API to live backend so cookies work via the proxy origin.
      '/api': { target: 'https://claude-sync-production.up.railway.app', changeOrigin: true, secure: true, cookieDomainRewrite: 'localhost' },
      '/auth': { target: 'https://claude-sync-production.up.railway.app', changeOrigin: true, secure: true, cookieDomainRewrite: 'localhost' },
      '/healthz': { target: 'https://claude-sync-production.up.railway.app', changeOrigin: true, secure: true },
    },
  },
});
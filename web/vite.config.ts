import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
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
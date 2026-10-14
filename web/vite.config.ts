import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';

// The daemon serves the built app from dist/web. `npm run dev:web` runs this
// dev server instead and forwards /api to the daemon, rewriting Origin so the
// daemon's cross-origin check sees its own address.
const daemonUrl = `http://127.0.0.1:${process.env['AGENTBOARD_WEB_PORT'] ?? '4317'}`;

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: daemonUrl,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => {
            if (req.getHeader('origin')) {
              req.setHeader('origin', daemonUrl);
            }
          });
        },
      },
    },
  },
});

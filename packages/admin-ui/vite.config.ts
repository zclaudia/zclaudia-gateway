import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Deployed under the gateway's /admin path; asset URLs are prefixed accordingly.
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  server: {
    proxy: {
      // Dev-only: forward API calls to a locally running gateway so the SPA
      // is same-origin with the session cookie without a build step.
      '/api': 'http://127.0.0.1:3200',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});

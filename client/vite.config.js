import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
        // A check drives a real browser over three Reddit pages and routinely
        // takes 45 s, more when Reddit is slow or a challenge has to be waited
        // out. The proxy's default timeouts are far shorter than that, and when
        // one fires it answers 500 with an EMPTY body -- so the dashboard shows
        // a bare "HTTP 500" with no message, while the check itself carries on
        // server-side and the next click answers 409 "already running".
        //
        // Only dev is affected: `npm run build && npm start` serves the client
        // from the API itself, with no proxy in between.
        proxyTimeout: 300000,
        timeout: 300000,
      },
    },
  },
});

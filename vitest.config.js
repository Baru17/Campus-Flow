import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Frontend tests.
 *
 * Separate from `vite.config.js` so the PWA plugin, the Tailwind pipeline and the dev
 * server's `/api` proxy are not part of a test run. Nothing here needs them.
 *
 * `environment` is `node` by default; the suites that render React opt into jsdom with a
 * `// @vitest-environment jsdom` line at the top of the file, because only those need a
 * DOM and paying for one in the pure-module suites would just be slower.
 *
 * `VITE_API_BASE_URL` is pinned so `src/api/backendUrl.js` resolves to something
 * non-empty without depending on whether a developer's `.env` is present. It is only ever
 * concatenated onto a stubbed `fetch`; no test opens a socket.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['test/**/*.spec.js', 'test/**/*.spec.jsx'],
    env: {
      VITE_API_BASE_URL: 'https://backend.test',
      VITE_API_MODE: 'proxy',
    },
  },
})

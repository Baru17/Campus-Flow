import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

/*
 * The session cookie is only first-party while the browser talks to this dev
 * server, so the Worker has to be told the client is on plain HTTP. It answers
 * with a `Secure; Partitioned` cookie (correct for a direct HTTPS call), and a
 * browser on http://localhost would discard that as a third-party cookie and
 * silently sign the user out. So the proxy also downgrades the relayed
 * Set-Cookie to a first-party one.
 */
function firstPartyCookieRewriter() {
  return (proxyRes, _req, res) => {
    const cookies = proxyRes.headers['set-cookie']
    if (!cookies) return
    const list = Array.isArray(cookies) ? cookies : [cookies]
    const rewritten = list.map((cookie) =>
      cookie
        .replace(/;\s*Secure/gi, '')
        .replace(/;\s*Partitioned/gi, '')
        .replace(/;\s*SameSite=None/gi, '; SameSite=Lax')
    )
    proxyRes.headers['set-cookie'] = rewritten
    res.setHeader('set-cookie', rewritten)
  }
}

function apiProxy(target) {
  return {
    target,
    changeOrigin: true,
    secure: true,
    headers: { 'X-Forwarded-Proto': 'http' },
    configure(proxy) {
      proxy.on('proxyRes', firstPartyCookieRewriter())
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const target = env.VITE_API_BASE_URL || 'https://backend.bdharan06.workers.dev'

  return {
    plugins: [
      react(),
      tailwindcss(),

      /*
       * Makes the built site installable: it emits the web app manifest, generates
       * the Workbox service worker, and registers it.
       *
       * Everything about the offline behaviour is deliberately conservative, because
       * attendance and OD are live operations where a stale cached answer is worse
       * than no answer at all:
       *
       * - No `runtimeCaching` entries at all. Workbox only serves what it was told to
       *   serve, so with none declared the precache below is the entire footprint --
       *   `/api/*`, attendance, OTP, OD and session requests all go to the network.
       * - `globPatterns` is limited to the hashed build output and `public/` icons, so
       *   nothing user-specific can be swept into the precache.
       * - `navigateFallback` answers navigations from the cached `index.html`, which is
       *   what keeps a refresh of a deep link such as `/role-selection` working when
       *   the app is installed. `navigateFallbackDenylist` keeps `/api/*` out of that
       *   path even though no client route starts with `/api`.
       * - `devOptions` is left off, so `npm run dev` talks to the network exactly as it
       *   did before and a stale worker cannot be left behind on a developer's machine.
       */
      VitePWA({
        registerType: 'prompt',
        manifest: {
          id: '/',
          name: 'CampusFlow',
          short_name: 'CampusFlow',
          description:
            'CampusFlow — OTP-verified college attendance and on-duty (OD) management for students, staff and administrators.',
          lang: 'en',
          dir: 'ltr',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'portrait',
          theme_color: '#2563eb',
          background_color: '#f6f7fb',
          categories: ['education', 'productivity'],
          icons: [
            { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            {
              src: '/pwa-maskable-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'maskable',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: [
            '**/*.{js,css,html,ico,png,svg,webp,webmanifest,woff,woff2,ttf}',
          ],
          // The xlsx report writer is a single sizeable chunk; the Workbox default of
          // 2 MiB would silently drop it from the precache.
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//],
          cleanupOutdatedCaches: true,
        },
      }),
    ],
    server: {
      port: 5173,
      open: false,
      proxy: { '/api': apiProxy(target) },
    },
    preview: {
      port: 4173,
      proxy: { '/api': apiProxy(target) },
    },
  }
})

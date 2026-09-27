import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
    plugins: [react(), tailwindcss()],
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

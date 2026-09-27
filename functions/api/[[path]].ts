const DEFAULT_BACKEND_ORIGIN = "https://backend.bdharan06.workers.dev"

interface ProxyEnv {
  BACKEND_ORIGIN?: string
}

interface ProxyContext {
  request: Request
  env: ProxyEnv
}

type ProxyHandler = (context: ProxyContext) => Promise<Response>

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade"])

/*
 * The browser reaches this function on the Pages origin, so the session cookie
 * it receives is first-party and must not carry cross-site attributes. The
 * Worker builds the cookie from what it believes the client scheme to be, which
 * is always HTTPS on this hop, so the `Secure; Partitioned; SameSite=None`
 * variant is downgraded here before it is relayed.
 */
function toFirstPartyCookie(cookie: string): string {
  return cookie
    .replace(/;\s*Partitioned/gi, "")
    .replace(/;\s*SameSite=None/gi, "; SameSite=Lax")
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
}

export const onRequest: ProxyHandler = async ({ request, env }) => {
  const backendOrigin = (env?.BACKEND_ORIGIN || DEFAULT_BACKEND_ORIGIN).replace(/\/+$/, "")
  const incoming = new URL(request.url)
  const target = `${backendOrigin}${incoming.pathname}${incoming.search}`

  const headers = new Headers()
  const cookie = request.headers.get("Cookie")
  if (cookie) headers.set("Cookie", cookie)
  const contentType = request.headers.get("Content-Type")
  if (contentType) headers.set("Content-Type", contentType)
  const accept = request.headers.get("Accept")
  if (accept) headers.set("Accept", accept)
  const origin = request.headers.get("Origin")
  if (origin) headers.set("Origin", origin)
  headers.set("X-Forwarded-Proto", incoming.protocol === "https:" ? "https" : "http")
  headers.set("X-Forwarded-Host", incoming.host)

  const hasBody = request.method !== "GET" && request.method !== "HEAD"

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
    })
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: "Attendance service is unreachable. Please try again." }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    )
  }

  const responseHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return
    if (key.toLowerCase() === "set-cookie") return
    responseHeaders.set(key, value)
  })

  const setCookies = upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : []
  const isFirstParty = incoming.protocol === "https:" || isLoopback(incoming.hostname)
  for (const value of setCookies) {
    const cookie = isFirstParty ? toFirstPartyCookie(value) : value
    responseHeaders.append("Set-Cookie", cookie)
  }
  if (setCookies.length === 0) {
    const single = upstream.headers.get("Set-Cookie")
    if (single) responseHeaders.set("Set-Cookie", isFirstParty ? toFirstPartyCookie(single) : single)
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  })
}

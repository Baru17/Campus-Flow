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
  for (const value of setCookies) {
    responseHeaders.append("Set-Cookie", value)
  }
  if (setCookies.length === 0) {
    const single = upstream.headers.get("Set-Cookie")
    if (single) responseHeaders.set("Set-Cookie", single)
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  })
}

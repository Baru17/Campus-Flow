const configuredBackendUrl = import.meta.env.VITE_API_BASE_URL || ''
const pagesProjectHost = import.meta.env.VITE_PAGES_HOST || 'campus-flow-cdl.pages.dev'

function isPagesHosted() {
  if (typeof window === 'undefined') return false
  const { hostname } = window.location
  return hostname === pagesProjectHost || hostname.endsWith(`.${pagesProjectHost}`)
}

export const BACKEND_URL = import.meta.env.DEV || isPagesHosted()
  ? window.location.origin
  : configuredBackendUrl

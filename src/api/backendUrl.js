const configuredBackendUrl = import.meta.env.VITE_API_BASE_URL || ''

export const BACKEND_URL = import.meta.env.DEV
  ? window.location.origin
  : configuredBackendUrl
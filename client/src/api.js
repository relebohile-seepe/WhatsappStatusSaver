// All REST API calls go directly to the Render backend.
// Netlify's redirect proxy does not reliably forward POST bodies or responses,
// so we bypass it the same way Socket.IO does — using VITE_BACKEND_URL directly.
// CORS is already configured on the server to allow the Netlify origin.
const BASE = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

export async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options)
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  return { res, data }
}

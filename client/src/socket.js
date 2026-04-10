import { io } from 'socket.io-client'

// In production the socket connects directly to the Render backend (WebSocket
// upgrades cannot be proxied by Netlify redirects). VITE_BACKEND_URL must be
// set in the Netlify environment variables to your Render service URL.
// In local dev it falls back to localhost:3001.
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const socket = io(BACKEND_URL, { autoConnect: true })
export default socket

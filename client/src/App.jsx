import { useState, useEffect } from 'react'
import socket from './socket'
import { apiFetch } from './api'
import QRScreen from './components/QRScreen'
import LoadingScreen from './components/LoadingScreen'
import NavBar from './components/NavBar'
import StatusGallery from './components/StatusGallery'
import ChatView from './components/ChatView'
import AdminPanel from './components/AdminPanel'
import './App.css'

export default function App() {
  const [appState, setAppState] = useState('initializing') // initializing | qr | loading | ready | disconnected
  const [qr, setQr] = useState(null)
  const [loadingPercent, setLoadingPercent] = useState(0)
  const [statuses, setStatuses] = useState([])
  const validTabs = ['status', 'chat', 'admin']
  const hashTab = window.location.hash.replace('#', '')
  const [activeTab, setActiveTab] = useState(validTabs.includes(hashTab) ? hashTab : 'status')

  useEffect(() => {
    // Get initial state from server
    apiFetch('/api/status')
      .then(({ data }) => {
        setAppState(data.status)
        if (data.qr) setQr(data.qr)
      })
      .catch(() => {})

    socket.on('status_state', ({ status, qr }) => {
      setAppState(status)
      if (qr) setQr(qr)
    })

    socket.on('qr', ({ qr }) => {
      setQr(qr)
      setAppState('qr')
    })

    socket.on('authenticated', () => {
      setAppState('loading')
      setQr(null)
    })

    socket.on('loading', ({ percent }) => {
      setAppState('loading')
      setLoadingPercent(percent)
    })

    socket.on('ready', () => {
      setAppState('ready')
      fetchStatuses()
    })

    socket.on('statuses_updated', (data) => {
      setStatuses(data)
    })

    socket.on('disconnected', () => {
      setAppState('disconnected')
      setQr(null)
    })

    return () => socket.removeAllListeners()
  }, [])

  const fetchStatuses = async () => {
    try {
      const { data } = await apiFetch('/api/statuses')
      setStatuses(data)
    } catch (e) {
      console.error('Failed to fetch statuses', e)
    }
  }

  const handleLogout = async () => {
    await apiFetch('/api/logout', { method: 'POST' })
    setStatuses([])
    setAppState('initializing')
    setActiveTab('status')
  }

  // Admin panel is always accessible directly — it has its own password gate.
  // Skip all WhatsApp connection screens when the admin tab is active.
  if (activeTab !== 'admin') {
    if (appState === 'initializing') {
      return (
        <div className="center-screen">
          <div className="spinner" />
          <p className="muted">Connecting to WhatsApp…</p>
        </div>
      )
    }

    if (appState === 'disconnected') {
      return (
        <div className="center-screen">
          <div className="disconnect-icon">⚠️</div>
          <h2>Disconnected</h2>
          <p className="muted">WhatsApp was disconnected. Reconnecting…</p>
          <div className="spinner" style={{ marginTop: 20 }} />
        </div>
      )
    }

    if (appState === 'qr') {
      return <QRScreen qr={qr} />
    }

    if (appState === 'loading') {
      return <LoadingScreen percent={loadingPercent} />
    }
  }

  return (
    <div className="app-shell">
      <NavBar
        activeTab={activeTab}
        onTabChange={(tab) => {
          setActiveTab(tab)
          window.location.hash = tab
        }}
        onLogout={handleLogout}
      />

      {activeTab === 'status' && (
        <StatusGallery
          statuses={statuses}
          onRefresh={fetchStatuses}
        />
      )}

      {activeTab === 'chat' && <ChatView />}

      {activeTab === 'admin' && <AdminPanel />}
    </div>
  )
}

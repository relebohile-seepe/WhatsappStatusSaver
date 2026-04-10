import { useEffect, useRef, useState, useCallback } from 'react'
import socket from '../socket'
import './WaStream.css'

const STREAM_W = 1280
const STREAM_H = 760

// Shared WhatsApp Web stream viewer used by both the Chat tab and Admin panel.
// Streams screenshots of the already-authenticated puppeteer page and forwards
// all mouse / keyboard events back so the user can interact normally.
//
// Downloads: puppeteer intercepts all WA Web downloads. The server saves them
// to stream_downloads/, issues a one-time token, and pushes a socket event
// here so we can open the real browser download dialog for the user.
export default function WaStream() {
  const imgRef   = useRef(null)
  const innerRef = useRef(null)
  const [ready,      setReady]      = useState(false)
  const [downloads,  setDownloads]  = useState([])  // pending download notifications
  const [grabbing,   setGrabbing]   = useState(false)
  const [grabError,  setGrabError]  = useState(null)

  useEffect(() => {
    socket.emit('start_wa_stream')

    const onFrame = (b64) => {
      if (imgRef.current) {
        imgRef.current.src = 'data:image/jpeg;base64,' + b64
        if (!ready) setReady(true)
      }
    }

    // Server intercepted a puppeteer download — push a notification so the
    // user can click through to get the file in their own browser.
    const onDownloadReady = (info) => {
      setDownloads(prev => [...prev, { ...info, id: Date.now() }])
    }

    const onGrabError = (msg) => {
      setGrabError(msg)
      setGrabbing(false)
      setTimeout(() => setGrabError(null), 4000)
    }

    socket.on('wa_frame',         onFrame)
    socket.on('wa_download_ready', onDownloadReady)
    socket.on('wa_grab_error',    onGrabError)

    return () => {
      socket.emit('stop_wa_stream')
      socket.off('wa_frame',         onFrame)
      socket.off('wa_download_ready', onDownloadReady)
      socket.off('wa_grab_error',    onGrabError)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Map click/wheel position from display space → puppeteer viewport space
  const toCoords = useCallback((e) => {
    const el = innerRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(((e.clientX - r.left) / r.width)  * STREAM_W),
      y: Math.round(((e.clientY - r.top)  / r.height) * STREAM_H),
    }
  }, [])

  const onClick       = (e) => { socket.emit('wa_click',   toCoords(e)); innerRef.current?.focus() }
  const onDblClick    = (e) =>   socket.emit('wa_dblclick', toCoords(e))
  const onContextMenu = (e) => { e.preventDefault(); socket.emit('wa_rclick', toCoords(e)) }
  const onWheel       = (e) =>   socket.emit('wa_scroll', { ...toCoords(e), deltaY: e.deltaY })

  const onKeyDown = useCallback(async (e) => {
    const ctrl  = e.ctrlKey || e.metaKey
    const shift = e.shiftKey
    const alt   = e.altKey

    if (ctrl && e.key === 'v') {
      e.preventDefault()
      try {
        const text = await navigator.clipboard.readText()
        if (text) socket.emit('wa_paste', { text })
      } catch (_) {}
      return
    }

    if (ctrl || alt) {
      e.preventDefault()
      socket.emit('wa_hotkey', { key: e.key, ctrl, shift, alt })
      return
    }

    const special = [
      'Enter','Backspace','Delete','Escape','Tab',
      'ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
      'Home','End','PageUp','PageDown',
      'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
    ]
    if (special.includes(e.key)) {
      e.preventDefault()
      socket.emit('wa_key', { key: e.key })
      return
    }

    if (e.key.length === 1) {
      e.preventDefault()
      socket.emit('wa_type', { text: e.key })
    }
  }, [])

  const dismissDownload = (id) =>
    setDownloads(prev => prev.filter(d => d.id !== id))

  const triggerDownload = (dl) => {
    window.open(dl.url, '_blank')
    dismissDownload(dl.id)
  }

  const grabVideo = () => {
    setGrabbing(true)
    setGrabError(null)
    socket.emit('wa_grab_video')
    // grabbing state cleared by onDownloadReady or onGrabError
    setTimeout(() => setGrabbing(false), 5000) // safety timeout
  }

  // When a grab succeeds the download_ready event fires — clear grabbing state
  useEffect(() => {
    if (downloads.length > 0) setGrabbing(false)
  }, [downloads])

  return (
    <div className="wa-stream-shell">
      {!ready && (
        <div className="wa-stream-loading">
          <div className="spinner" />
          <p>Connecting to WhatsApp…</p>
          <span>Session already active — no scan needed</span>
        </div>
      )}

      <div
        ref={innerRef}
        className={`wa-stream-inner ${ready ? 'visible' : ''}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
        onContextMenu={onContextMenu}
        style={{ aspectRatio: `${STREAM_W} / ${STREAM_H}` }}
      >
        <img
          ref={imgRef}
          className="wa-stream-img"
          alt="WhatsApp"
          draggable={false}
          onClick={onClick}
          onDoubleClick={onDblClick}
        />
      </div>

      {/* Grab video button — always visible when stream is ready */}
      {ready && (
        <button
          className={`wa-grab-btn ${grabbing ? 'grabbing' : ''}`}
          onClick={grabVideo}
          disabled={grabbing}
          title="Grab the currently open video and download it"
        >
          {grabbing ? '⏳ Clicking download…' : '⬇️ Grab Media'}
        </button>
      )}

      {/* Error toast */}
      {grabError && (
        <div className="wa-grab-error">{grabError}</div>
      )}

      {/* Download notifications — one card per intercepted download */}
      {downloads.length > 0 && (
        <div className="wa-dl-stack">
          {downloads.map(dl => (
            <div key={dl.id} className="wa-dl-card">
              <div className="wa-dl-info">
                <span className="wa-dl-icon">{iconFor(dl.filename)}</span>
                <div className="wa-dl-text">
                  <div className="wa-dl-name">{dl.filename}</div>
                  {dl.size && (
                    <div className="wa-dl-size">{formatBytes(dl.size)}</div>
                  )}
                </div>
              </div>
              <div className="wa-dl-actions">
                <button className="wa-dl-btn primary" onClick={() => triggerDownload(dl)}>
                  Download
                </button>
                <button className="wa-dl-btn" onClick={() => dismissDownload(dl.id)}>
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function iconFor(filename = '') {
  const ext = filename.split('.').pop().toLowerCase()
  if (['mp4','mov','avi','webm','mkv'].includes(ext)) return '🎬'
  if (['jpg','jpeg','png','gif','webp'].includes(ext))  return '🖼️'
  if (['mp3','ogg','aac','opus'].includes(ext))         return '🎵'
  if (['pdf'].includes(ext))                            return '📄'
  return '📎'
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

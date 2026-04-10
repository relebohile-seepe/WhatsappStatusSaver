import { useState } from 'react'
import './StatusCard.css'

const MIME_ICONS = { image: '🖼️', video: '🎥', audio: '🎵', text: '📝', document: '📄' }

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function StatusCard({ contact, onViewMedia }) {
  const [downloading, setDownloading] = useState(null)

  const handleDownload = async (update, e) => {
    e.stopPropagation()
    setDownloading(update.id)
    try {
      const res = await fetch(`/api/download/${encodeURIComponent(update.id)}`)
      if (!res.ok) throw new Error('Download failed')
      const blob = await res.blob()
      const ext = blob.type.split('/')[1]?.split(';')[0] || 'bin'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${contact.contactName}_${update.timestamp || Date.now()}.${ext}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      alert('Download failed: ' + err.message)
    } finally {
      setDownloading(null)
    }
  }

  const mediaUpdates = contact.updates.filter(u => ['image', 'video', 'audio', 'document'].includes(u.type))
  const textUpdates = contact.updates.filter(u => u.type === 'text' || u.type === 'chat')

  return (
    <div className="status-card">
      {/* Contact header */}
      <div className="card-header">
        <div className="avatar">
          {contact.contactName?.[0]?.toUpperCase() || '?'}
        </div>
        <div className="card-contact-info">
          <span className="contact-name">{contact.contactName || contact.phone}</span>
          <span className="contact-phone">{contact.phone}</span>
        </div>
        <span className="update-count">{contact.updates.length}</span>
      </div>

      {/* Text statuses */}
      {textUpdates.map(u => (
        <div key={u.id} className="text-status">
          <span className="status-icon">📝</span>
          <p className="status-body">{u.body || u.caption || '(text status)'}</p>
          <span className="status-time">{formatTime(u.timestamp)}</span>
        </div>
      ))}

      {/* Media statuses */}
      {mediaUpdates.length > 0 && (
        <div className="media-list">
          {mediaUpdates.map(u => (
            <div
              key={u.id}
              className="media-item"
              onClick={() => onViewMedia(u)}
              role="button"
              tabIndex={0}
            >
              <div className="media-thumb">
                <span>{MIME_ICONS[u.type] || '📎'}</span>
              </div>
              <div className="media-info">
                <span className="media-type">{u.type}</span>
                {u.caption && <span className="media-caption">{u.caption}</span>}
                <span className="media-time">{formatTime(u.timestamp)}</span>
              </div>
              <button
                className="btn-dl"
                onClick={(e) => handleDownload(u, e)}
                disabled={downloading === u.id}
                title="Download"
              >
                {downloading === u.id ? '⏳' : '⬇'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

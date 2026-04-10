import { useEffect } from 'react'
import './StatusModal.css'

export default function StatusModal({ item, onClose }) {
  const { update, contactName } = item

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleDownload = async () => {
    const res = await fetch(`/api/download/${encodeURIComponent(update.id)}`)
    if (!res.ok) { alert('Download failed'); return }
    const blob = await res.blob()
    const ext = blob.type.split('/')[1]?.split(';')[0] || 'bin'
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${contactName}_${update.timestamp || Date.now()}.${ext}`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="modal-contact">{contactName}</span>
            <span className="modal-type">{update.type}</span>
          </div>
          <div className="modal-header-actions">
            <button className="btn-dl-modal" onClick={handleDownload}>⬇ Download</button>
            <button className="modal-close" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="modal-content">
          {update.type === 'image' ? (
            <div className="media-preview image-preview">
              <span className="media-icon-large">🖼️</span>
              <p>Image preview not available in browser.<br />Use the Download button to save it.</p>
            </div>
          ) : update.type === 'video' ? (
            <div className="media-preview">
              <span className="media-icon-large">🎥</span>
              <p>Video preview not available in browser.<br />Use the Download button to save it.</p>
            </div>
          ) : update.type === 'audio' ? (
            <div className="media-preview">
              <span className="media-icon-large">🎵</span>
              <p>Audio preview not available in browser.<br />Use the Download button to save it.</p>
            </div>
          ) : (
            <div className="media-preview">
              <p className="text-body">{update.body || update.caption || '(no content)'}</p>
            </div>
          )}

          {update.caption && update.type !== 'text' && (
            <p className="modal-caption">"{update.caption}"</p>
          )}
        </div>
      </div>
    </div>
  )
}

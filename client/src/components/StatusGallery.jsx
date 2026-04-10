import { useState } from 'react'
import StatusCard from './StatusCard'
import StatusModal from './StatusModal'
import { apiFetch } from '../api'
import './StatusGallery.css'

export default function StatusGallery({ statuses, onRefresh }) {
  const [downloading, setDownloading] = useState(false)
  const [downloadResult, setDownloadResult] = useState(null)
  const [modalItem, setModalItem] = useState(null) // { update, contactName }

  const handleDownloadAll = async () => {
    setDownloading(true)
    setDownloadResult(null)
    try {
      const { data } = await apiFetch('/api/download-all', { method: 'POST' })
      setDownloadResult(data)
    } catch (e) {
      setDownloadResult({ error: e.message })
    } finally {
      setDownloading(false)
    }
  }

  const totalUpdates = statuses.reduce((acc, s) => acc + s.updates.length, 0)
  const mediaUpdates = statuses.reduce(
    (acc, s) => acc + s.updates.filter(u => ['image', 'video', 'audio'].includes(u.type)).length,
    0
  )

  return (
    <div className="gallery-layout">
      {/* Toolbar */}
      <div className="gallery-toolbar">
        <p className="gallery-stats">
          {statuses.length} contacts · {totalUpdates} updates · {mediaUpdates} media
        </p>
        <div className="toolbar-actions">
          <button className="btn-icon" onClick={onRefresh} title="Refresh">
            🔄
          </button>
          <button
            className="btn-download-all"
            onClick={handleDownloadAll}
            disabled={downloading || mediaUpdates === 0}
          >
            {downloading ? 'Downloading…' : `⬇ Download All (${mediaUpdates})`}
          </button>
        </div>
      </div>

      {/* Download result banner */}
      {downloadResult && (
        <div className={`result-banner ${downloadResult.error ? 'error' : 'success'}`}>
          {downloadResult.error
            ? `Error: ${downloadResult.error}`
            : `✓ Saved ${downloadResult.saved} file${downloadResult.saved !== 1 ? 's' : ''} to downloads/ folder`}
          <button className="banner-close" onClick={() => setDownloadResult(null)}>✕</button>
        </div>
      )}

      {/* Content */}
      <main className="gallery-main">
        {statuses.length === 0 ? (
          <div className="empty-state">
            <span>👁️</span>
            <h3>No status updates found</h3>
            <p>
              WhatsApp only loads status data after opening the Status tab.<br />
              Click <strong>Refresh</strong> to try again — it may take a few seconds.
            </p>
            <button className="btn-download-all" onClick={onRefresh}>🔄 Refresh Statuses</button>
            <p className="empty-hint">
              Tip: If statuses still don't appear, check{' '}
              <a href="/api/debug/stores" target="_blank" rel="noreferrer"
                 style={{color:'var(--green)'}}>
                the debug page
              </a>{' '}
              and share the output.
            </p>
          </div>
        ) : (
          <div className="gallery-grid">
            {statuses.map(contact => (
              <StatusCard
                key={contact.id}
                contact={contact}
                onViewMedia={(update) => setModalItem({ update, contactName: contact.contactName })}
              />
            ))}
          </div>
        )}
      </main>

      {/* Media modal */}
      {modalItem && (
        <StatusModal item={modalItem} onClose={() => setModalItem(null)} />
      )}
    </div>
  )
}

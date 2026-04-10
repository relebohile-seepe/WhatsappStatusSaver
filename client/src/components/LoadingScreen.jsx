import './LoadingScreen.css'

export default function LoadingScreen({ percent }) {
  return (
    <div className="loading-screen">
      <span className="wa-logo">💬</span>
      <h2>Loading WhatsApp…</h2>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${percent || 10}%` }} />
      </div>
      <p className="loading-pct">{percent || 0}%</p>
    </div>
  )
}

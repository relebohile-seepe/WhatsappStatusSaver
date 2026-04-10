import './NavBar.css'

export default function NavBar({ activeTab, onTabChange, onLogout }) {
  return (
    <nav className="navbar">
      <div className="nav-brand">
        <span className="nav-logo">💬</span>
        <span className="nav-title">WhatsApp Viewer</span>
      </div>

      <div className="nav-tabs">
        {['status', 'chat', 'admin'].map(tab => (
          <button
            key={tab}
            className={`nav-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => onTabChange(tab)}
          >
            {tab === 'status' && '📷 Status'}
            {tab === 'chat'   && ''}
            {tab === 'admin'  && ''}
          </button>
        ))}
      </div>

      <button className="nav-logout" onClick={onLogout}>
        Logout
      </button>
    </nav>
  )
}

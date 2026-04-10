import './QRScreen.css'

export default function QRScreen({ qr }) {
  return (
    <div className="qr-screen">
      <div className="qr-card">
        <div className="qr-header">
          <span className="wa-logo">💬</span>
          <h1>WhatsApp Status Saver</h1>
        </div>

        <p className="qr-instruction">
          Scan this QR code with your WhatsApp to connect
        </p>

        <div className="qr-box">
          {qr ? (
            <img src={qr} alt="WhatsApp QR Code" className="qr-image" />
          ) : (
            <div className="qr-placeholder">
              <div className="spinner-large" />
              <p>Generating QR code…</p>
            </div>
          )}
        </div>

        <div className="qr-steps">
          <div className="step">
            <span className="step-num">1</span>
            <span>Open WhatsApp on your phone</span>
          </div>
          <div className="step">
            <span className="step-num">2</span>
            <span>Tap <strong>Linked Devices</strong> → <strong>Link a Device</strong></span>
          </div>
          <div className="step">
            <span className="step-num">3</span>
            <span>Point your phone camera at this screen</span>
          </div>
        </div>
      </div>
    </div>
  )
}

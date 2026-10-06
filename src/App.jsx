import { useRef, useState } from 'react'
import logoPlate from './assets/figma/2b7d2.svg'
import logoMark from './assets/figma/733b6.svg'
import notificationBubble from './assets/figma/894b8.svg'
import avatarPlate from './assets/figma/9b37f.svg'
import chevron from './assets/figma/21c36.svg'
import scanIconPlate from './assets/figma/14ca8.svg'
import scanIcon from './assets/figma/316d0.svg'
import barcodeScanner from './assets/figma/c6ae5.svg'
import clockIcon from './assets/figma/557ea.svg'
import clockHand from './assets/figma/b4663.svg'
import searchIcon from './assets/figma/0967f.svg'
import searchHandle from './assets/figma/64074.svg'
import infoIcon from './assets/figma/afda1.svg'
import scannerPlate from './assets/figma/3c26b.svg'
import scannerIcon from './assets/figma/1988b.svg'
import scalePlate from './assets/figma/a440e.svg'
import scaleIcon from './assets/figma/dd3fb.svg'
import checkPlate from './assets/figma/56d09.svg'
import checkMark from './assets/figma/012f0.svg'
import shieldPlate from './assets/figma/cbe13.svg'
import shieldIcon from './assets/figma/d88f6.svg'
import shieldCheck from './assets/figma/70c7b.svg'
import pageBackground from './assets/figma/24aa6.svg'
import './App.css'

const workflowSteps = [
  ['1', 'Identify return', 'Scan or look up the item'],
  ['2', 'Inspect item', 'Compare images and measurements'],
  ['3', 'Review decision', 'Approve, escalate, or flag'],
]

function LayeredIcon({ className = '', children }) {
  return <span className={`layered-icon ${className}`}>{children}</span>
}

function App() {
  const [mode, setMode] = useState('barcode')
  const [lookup, setLookup] = useState('')
  const [status, setStatus] = useState('')
  const inputRef = useRef(null)

  const chooseMode = (nextMode) => {
    setMode(nextMode)
    setStatus('')
    if (nextMode === 'order') {
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  const findReturn = (event) => {
    event.preventDefault()
    const value = lookup.trim()
    setStatus(
      value
        ? `Searching for ${value}…`
        : 'Enter an order number, SKU, serial number, or return ID.',
    )
  }

  return (
    <div className="app-shell" style={{ backgroundImage: `url(${pageBackground})` }}>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#main" aria-label="ReturnScan home">
            <LayeredIcon className="brand-icon">
              <img src={logoPlate} alt="" />
              <img src={logoMark} alt="" />
            </LayeredIcon>
            <span>ReturnScan</span>
          </a>

          <nav className="primary-nav" aria-label="Primary navigation">
            <button className="nav-link active" type="button">New Return</button>
            <button className="nav-link" type="button">Return History</button>
            <button className="nav-link queue-link" type="button">
              Review Queue
              <LayeredIcon className="notification-badge">
                <img src={notificationBubble} alt="" />
                <span>3</span>
              </LayeredIcon>
            </button>
          </nav>

          <div className="account-tools">
            <span className="devices-ready"><i />Devices ready</span>
            <button className="profile-button" type="button" aria-label="Open Jane Doe profile menu">
              <LayeredIcon className="avatar">
                <img src={avatarPlate} alt="" />
                <span>JD</span>
              </LayeredIcon>
              <span className="profile-copy">
                <strong>Jane Doe</strong>
                <small>Reviewer</small>
              </span>
              <img className="chevron" src={chevron} alt="" />
            </button>
          </div>
        </div>
      </header>

      <main id="main" className="page-content">
        <ol className="workflow" aria-label="Return workflow">
          {workflowSteps.map(([number, title, description], index) => (
            <li className={index === 0 ? 'workflow-step active' : 'workflow-step'} key={number}>
              <span className="step-number">{number}</span>
              <span className="step-copy">
                <strong>{title}</strong>
                <small>{description}</small>
              </span>
            </li>
          ))}
        </ol>

        <section className="intro" aria-labelledby="page-title">
          <div>
            <span className="eyebrow">New return</span>
            <h1 id="page-title">Identify the returned item</h1>
            <p>Scan the product barcode or use an order identifier to start a verified return.</p>
          </div>
          <div className="case-status">
            <span>Return case</span>
            <strong>Created after identification</strong>
          </div>
        </section>

        <div className="dashboard-grid">
          <section className="scan-card" aria-labelledby="scan-title">
            <div className="scan-card-header">
              <div className="scan-title-group">
                <LayeredIcon className="scan-title-icon">
                  <img src={scanIconPlate} alt="" />
                  <img src={scanIcon} alt="" />
                </LayeredIcon>
                <div>
                  <h2 id="scan-title">Scan item identity</h2>
                  <p>Position the barcode or QR code inside the guide.</p>
                </div>
              </div>
              <div className="mode-switch" aria-label="Identification method">
                <button
                  className={mode === 'barcode' ? 'active' : ''}
                  type="button"
                  onClick={() => chooseMode('barcode')}
                >
                  Barcode / QR
                </button>
                <button
                  className={mode === 'order' ? 'active' : ''}
                  type="button"
                  onClick={() => chooseMode('order')}
                >
                  Order ID
                </button>
              </div>
            </div>

            <div className={mode === 'barcode' ? 'scanner-panel' : 'scanner-panel order-mode'}>
              <span className="scanner-ready"><i />Scanner ready</span>
              <img className="barcode-art" src={barcodeScanner} alt="Barcode framed by scanner guides" />
              <h3>{mode === 'barcode' ? 'Ready to scan' : 'Order lookup selected'}</h3>
              <p>
                {mode === 'barcode'
                  ? 'Hold the code 6 to 12 inches from the scanner'
                  : 'Enter the return identifier below to continue'}
              </p>
              <span className="auto-detect">
                <LayeredIcon className="clock">
                  <img src={clockIcon} alt="" />
                  <img src={clockHand} alt="" />
                </LayeredIcon>
                {mode === 'barcode' ? 'Auto-detect is enabled' : 'Manual lookup is enabled'}
              </span>
            </div>

            <div className="manual-lookup">
              <div className="divider"><span>Or look up manually</span></div>
              <form className="lookup-form" onSubmit={findReturn}>
                <label className="lookup-field">
                  <span className="sr-only">Return identifier</span>
                  <LayeredIcon className="search">
                    <img src={searchIcon} alt="" />
                    <img src={searchHandle} alt="" />
                  </LayeredIcon>
                  <input
                    ref={inputRef}
                    value={lookup}
                    onChange={(event) => setLookup(event.target.value)}
                    placeholder="Enter order number, SKU, serial number, or return ID"
                  />
                </label>
                <button className="find-button" type="submit">Find return</button>
              </form>
              <div className="lookup-note" aria-live="polite">
                <LayeredIcon className="info"><img src={infoIcon} alt="" /></LayeredIcon>
                <span>{status || 'A return case is created only after the item and order are confirmed.'}</span>
              </div>
            </div>
          </section>

          <aside className="support-column" aria-label="Return intake support">
            <section className="support-card devices-card">
              <h2>Connected devices</h2>
              <p>Hardware is ready for a verified intake.</p>
              <div className="support-divider" />
              <div className="device-row">
                <LayeredIcon className="device-icon scanner-device">
                  <img src={scannerPlate} alt="" />
                  <img src={scannerIcon} alt="" />
                </LayeredIcon>
                <div><strong>Barcode scanner</strong><small>USB scanner / Station 01</small></div>
                <span className="status-pill connected">Connected</span>
              </div>
              <div className="device-row">
                <LayeredIcon className="device-icon scale-device">
                  <img src={scalePlate} alt="" />
                  <img src={scaleIcon} alt="" />
                </LayeredIcon>
                <div><strong>Smart scale</strong><small>Stable / Calibrated today</small></div>
                <span className="status-pill ready">Ready</span>
              </div>
            </section>

            <section className="support-card checklist-card">
              <h2>Before you scan</h2>
              <p>For the cleanest match, confirm these first.</p>
              <ul>
                {[
                  'Keep packaging and labels visible',
                  'Remove items from the scale',
                  'Use the original return authorization',
                ].map((item) => (
                  <li key={item}>
                    <LayeredIcon className="check">
                      <img src={checkPlate} alt="" />
                      <img src={checkMark} alt="" />
                    </LayeredIcon>
                    {item}
                  </li>
                ))}
              </ul>
              <div className="support-divider" />
              <a href="#scan-title">Need help? View the 60-second scanning guide</a>
            </section>

            <section className="evidence-card">
              <div className="evidence-heading">
                <LayeredIcon className="shield">
                  <img src={shieldPlate} alt="" />
                  <img src={shieldIcon} alt="" />
                  <img src={shieldCheck} alt="" />
                </LayeredIcon>
                <div>
                  <h2>Evidence-first verification</h2>
                  <p>The scan links this item to its original order.</p>
                </div>
              </div>
              <p>Images, identifiers, and weight readings are preserved for the reviewer. Automated signals never make the final decision.</p>
              <span className="evidence-accent" />
            </section>
          </aside>
        </div>
      </main>
    </div>
  )
}

export default App

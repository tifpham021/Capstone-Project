import { useEffect, useRef, useState } from 'react'
import logoPlate from './assets/figma/2b7d2.svg'
import logoMark from './assets/figma/733b6.svg'
import notificationBubble from './assets/figma/894b8.svg'
import chevron from './assets/figma/21c36.svg'
import scanIconPlate from './assets/figma/14ca8.svg'
import scanIcon from './assets/figma/316d0.svg'
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
import ItemInspection from './ItemInspection.jsx'
import ReviewDecision from './ReviewDecision.jsx'
import BarcodeScanner from './BarcodeScanner.jsx'
import LoginPage from './LoginPage.jsx'
import AccountDashboard, { ProfileAvatar } from './AccountDashboard.jsx'
import { loadSession, signOut } from './auth/authService.js'
import {
  clearDecisionHistory,
  loadDecisionHistory,
  loadPreferences,
  saveDecisionHistory,
  savePreferences,
} from './accountStorage.js'
import {
  RETURN_STATUS,
  canOpenStep,
  createIdentifiedReturn,
  getStatusLabel,
  transitionReturn,
} from './returnLifecycle.js'
import './App.css'

const workflowSteps = [
  ['1', 'Identify return', 'Scan or look up the item'],
  ['2', 'Inspect item', 'Compare images and measurements'],
  ['3', 'Review decision', 'Approve, escalate, or flag'],
]

const SAMPLE_LOOKUP = 'ORD-8921'

function LayeredIcon({ className = '', children }) {
  return <span className={`layered-icon ${className}`}>{children}</span>
}

function ProfileMenu({ user, onOpenAccount, onSignOut }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined

    const closeOnOutsideClick = (event) => {
      if (!menuRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const choose = (action) => {
    setOpen(false)
    action()
  }

  return (
    <div className="profile-menu" ref={menuRef}>
      <button
        className="profile-button"
        type="button"
        aria-label={`Open ${user.name} profile menu`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ProfileAvatar user={user} size="small" />
        <span className="profile-copy">
          <strong>{user.name}</strong>
          <small>{user.role}</small>
        </span>
        <img className="chevron" src={chevron} alt="" />
      </button>
      {open ? (
        <div className="profile-dropdown" role="menu" aria-label="Account">
          <div className="profile-dropdown-header">
            <strong>{user.name}</strong>
            <small>{user.email}</small>
          </div>
          <button type="button" role="menuitem" onClick={() => choose(onOpenAccount)}>Account dashboard</button>
          <button type="button" role="menuitem" className="sign-out-item" onClick={() => choose(onSignOut)}>Sign out</button>
        </div>
      ) : null}
    </div>
  )
}

function Workstation({ session, onSignOut }) {
  const { user } = session
  const [screen, setScreen] = useState('identify')
  const [returnCase, setReturnCase] = useState(null)
  const [preferences, setPreferences] = useState(() => loadPreferences(user.email))
  const [history, setHistory] = useState(() => loadDecisionHistory(user.email))
  const [mode, setMode] = useState(preferences.defaultLookupMode)
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

  const lookUpReturn = (rawValue) => {
    const value = rawValue.trim()
    if (!value) {
      setReturnCase((current) => (
        current?.status === RETURN_STATUS.IDENTIFIED ? null : current
      ))
      setStatus('Enter an order number, SKU, serial number, or return ID.')
      return
    }

    const identifiedReturn = createIdentifiedReturn(value)
    setReturnCase(identifiedReturn)
    setStatus(`Return ${identifiedReturn.id} identified. Confirm it to begin the inspection.`)
  }

  const findReturn = (event) => {
    event.preventDefault()
    lookUpReturn(lookup)
  }

  // A scanned code fills the lookup field. With auto-detect on it is looked up
  // right away; otherwise the reviewer confirms it with Find return.
  const handleScannedCode = (code) => {
    setLookup(code)
    if (preferences.autoDetect) {
      lookUpReturn(code)
    } else {
      setReturnCase((current) => (current?.status === RETURN_STATUS.IDENTIFIED ? null : current))
      setStatus(`Scanned ${code}. Check it, then select Find return.`)
    }
  }

  const updateLookup = (event) => {
    const value = event.target.value
    setLookup(value)
    setStatus('')
    setReturnCase((current) => (
      current?.status === RETURN_STATUS.IDENTIFIED
      && value.trim() !== current.lookupIdentifier
        ? null
        : current
    ))
  }

  // Steps 2 and 3 are always reachable. Without an identified return, the
  // sample return is loaded and moved forward so the page has case data.
  const openStep = (step, currentReturn = returnCase) => {
    if (currentReturn === returnCase && canOpenStep(currentReturn, step)) {
      setScreen(step)
      return
    }
    if (step === 'identify') {
      startNewReturn()
      return
    }

    let nextReturn = currentReturn || createIdentifiedReturn(SAMPLE_LOOKUP)
    if (nextReturn.status === RETURN_STATUS.IDENTIFIED) {
      nextReturn = transitionReturn(nextReturn, RETURN_STATUS.INSPECTION_IN_PROGRESS)
    }
    if (step === 'review' && nextReturn.status === RETURN_STATUS.INSPECTION_IN_PROGRESS) {
      nextReturn = transitionReturn(nextReturn, RETURN_STATUS.AWAITING_DECISION)
    }

    setReturnCase(nextReturn)
    setLookup(nextReturn.lookupIdentifier)
    setStatus('')
    setScreen(step)
  }

  const beginInspection = () => {
    setReturnCase((current) => (
      current.status === RETURN_STATUS.IDENTIFIED
        ? transitionReturn(current, RETURN_STATUS.INSPECTION_IN_PROGRESS)
        : current
    ))
    setScreen('inspection')
  }

  const continueToReview = () => {
    setReturnCase((current) => (
      current.status === RETURN_STATUS.INSPECTION_IN_PROGRESS
        ? transitionReturn(current, RETURN_STATUS.AWAITING_DECISION)
        : current
    ))
    setScreen('review')
  }

  const completeReturn = (decision) => {
    if (returnCase?.status !== RETURN_STATUS.AWAITING_DECISION) return

    const completedReturn = transitionReturn(returnCase, RETURN_STATUS.COMPLETED, {
      decision,
      activityLabel: `Decision recorded: ${decision.title}`,
    })
    const nextHistory = [{
      id: completedReturn.id,
      productName: completedReturn.productName,
      orderNumber: completedReturn.orderNumber,
      refundAmount: completedReturn.refundAmount,
      decision,
      completedAt: completedReturn.history.at(-1).occurredAt,
    }, ...history]

    setReturnCase(completedReturn)
    setHistory(nextHistory)
    saveDecisionHistory(user.email, nextHistory)
  }

  const startNewReturn = () => {
    if (returnCase?.status === RETURN_STATUS.COMPLETED) {
      setReturnCase(null)
      setLookup('')
      setStatus('')
    }
    setMode(preferences.defaultLookupMode)
    setScreen('identify')
  }

  const resumeReturn = () => {
    if (canOpenStep(returnCase, 'review')) setScreen('review')
    else if (canOpenStep(returnCase, 'inspection')) setScreen('inspection')
    else setScreen('identify')
  }

  const updatePreferences = (nextPreferences) => {
    setPreferences(nextPreferences)
    savePreferences(user.email, nextPreferences)
  }

  const clearHistory = () => {
    setHistory([])
    clearDecisionHistory(user.email)
  }

  return (
    <div className="app-shell" style={{ backgroundImage: `url(${pageBackground})` }}>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#main" aria-label="ReturnScan home" onClick={() => openStep('identify')}>
            <LayeredIcon className="brand-icon">
              <img src={logoPlate} alt="" />
              <img src={logoMark} alt="" />
            </LayeredIcon>
            <span>ReturnScan</span>
          </a>

          <nav className="primary-nav" aria-label="Primary navigation">
            <button
              className={screen === 'account' ? 'nav-link' : 'nav-link active'}
              type="button"
              onClick={startNewReturn}
            >
              New Return
            </button>
            <button
              className={screen === 'account' ? 'nav-link active' : 'nav-link'}
              type="button"
              onClick={() => setScreen('account')}
            >
              Return History
            </button>
            <button className="nav-link queue-link" type="button">
              Review Queue
              {preferences.queueNotifications ? (
                <LayeredIcon className="notification-badge">
                  <img src={notificationBubble} alt="" />
                  <span>3</span>
                </LayeredIcon>
              ) : null}
            </button>
          </nav>

          <div className="account-tools">
            <span className="devices-ready"><i />Devices ready</span>
            <ProfileMenu user={user} onOpenAccount={() => setScreen('account')} onSignOut={onSignOut} />
          </div>
        </div>
      </header>

      {screen === 'account' ? (
        <AccountDashboard
          session={session}
          activeReturn={returnCase}
          history={history}
          preferences={preferences}
          onPreferencesChange={updatePreferences}
          onClearHistory={clearHistory}
          onStartReturn={startNewReturn}
          onResumeReturn={resumeReturn}
          onOpenStep={(step) => openStep(
            step,
            returnCase?.status === RETURN_STATUS.COMPLETED ? null : returnCase,
          )}
          onSignOut={onSignOut}
        />
      ) : screen === 'identify' ? (
      <main id="main" className="page-content">
        <ol className="workflow" aria-label="Return workflow">
          {workflowSteps.map(([number, title, description], index) => {
            const step = ['identify', 'inspection', 'review'][index]
            const clickable = index > 0
            return (
            <li
              className={`${index === 0 ? 'workflow-step active' : 'workflow-step'}${clickable ? ' clickable' : ''}`}
              key={number}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={clickable ? `Open ${title.toLowerCase()}` : undefined}
              title={clickable && !canOpenStep(returnCase, step) ? 'Opens with the sample return ORD-8921' : undefined}
              onClick={clickable ? () => openStep(step) : undefined}
              onKeyDown={clickable ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') openStep(step)
              } : undefined}
            >
              <span className="step-number">{number}</span>
              <span className="step-copy">
                <strong>{title}</strong>
                <small>{description}</small>
              </span>
            </li>
            )
          })}
        </ol>

        <section className="intro" aria-labelledby="page-title">
          <div>
            <h1 id="page-title">Identify the returned item</h1>
            <p>Scan the product barcode or use an order identifier to start a verified return.</p>
          </div>
          <div className="case-status">
            <span>Return case</span>
            <strong>{returnCase?.id || 'Not created yet'}</strong>
            <small>{getStatusLabel(returnCase)}</small>
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

            <BarcodeScanner
              mode={mode}
              autoDetect={preferences.autoDetect}
              onDetected={handleScannedCode}
            />

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
                    onChange={updateLookup}
                    placeholder="Enter order number, SKU, serial number, or return ID"
                  />
                </label>
                <button className="find-button" type="submit">Find return</button>
              </form>
              <div className="lookup-note" aria-live="polite">
                <LayeredIcon className="info"><img src={infoIcon} alt="" /></LayeredIcon>
                <span>{status || 'A return case is created only after the item and order are confirmed.'}</span>
              </div>
              {returnCase ? (
                <div className="identified-return" aria-live="polite">
                  <div>
                    <strong>{returnCase.productName}</strong>
                    <span>Order #{returnCase.orderNumber} / {returnCase.productModel}</span>
                  </div>
                  <button type="button" onClick={beginInspection}>
                    {returnCase.status === RETURN_STATUS.IDENTIFIED ? 'Begin inspection' : 'Continue return'}
                  </button>
                </div>
              ) : null}
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
            </section>
          </aside>
        </div>
      </main>
      ) : screen === 'inspection' ? (
        <ItemInspection
          returnCase={returnCase}
          onBack={() => openStep('identify')}
          onContinue={continueToReview}
        />
      ) : (
        <ReviewDecision
          returnCase={returnCase}
          onIdentify={() => openStep('identify')}
          onBack={() => openStep('inspection')}
          onSubmitDecision={completeReturn}
          reviewerName={user.name}
        />
      )}
    </div>
  )
}

function App() {
  const [session, setSession] = useState(loadSession)
  const [notice, setNotice] = useState('')

  const handleSignIn = (nextSession) => {
    setNotice('')
    setSession(nextSession)
  }

  const handleSignOut = () => {
    signOut(session)
    setSession(null)
    setNotice('You have been signed out.')
  }

  if (!session) return <LoginPage onSignIn={handleSignIn} notice={notice} />

  return <Workstation key={session.user.email} session={session} onSignOut={handleSignOut} />
}

export default App

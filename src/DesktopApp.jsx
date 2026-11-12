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
import BarcodeScanner from './DesktopBarcodeScanner.jsx'
import LoginPage from './DesktopLoginPage.jsx'
import AccountDashboard, { ProfileAvatar } from './DesktopAccountDashboard.jsx'
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
  getStatusLabel,
  transitionReturn,
} from './returnLifecycle.js'
import { createReturn, recordDecision, searchOrders, setReturnStatus } from './api.js'
import { fromServerReturn, pickItem, pickOrder, provisionalReturn } from './returnRecords.js'
import './App.css'

const statusRank = (status) => Object.values(RETURN_STATUS).indexOf(status)

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
  const [creating, setCreating] = useState(false)
  const inputRef = useRef(null)
  const lookupRequest = useRef(0)

  // Replaces the case with the server's copy. A slow response (for example,
  // the visual check) never moves the return backward in the lifecycle.
  const applyServerReturn = (record) => {
    setReturnCase((current) => {
      const next = fromServerReturn(record)
      if (current?.saved && current.id === next.id && statusRank(next.status) < statusRank(current.status)) {
        next.status = current.status
        next.history = current.history
        next.decision = current.decision
      }
      return next
    })
  }

  const chooseMode = (nextMode) => {
    setMode(nextMode)
    setStatus('')
    if (nextMode === 'order') {
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  // Looks the identifier up in the orders database. If the server can't be
  // reached, falls back to the built-in demo return so the UI still works.
  const lookUpReturn = async (rawValue) => {
    const value = rawValue.trim()
    if (!value) {
      setReturnCase((current) => (
        current?.status === RETURN_STATUS.IDENTIFIED ? null : current
      ))
      setStatus('Enter an order number, SKU, serial number, or return ID.')
      return
    }

    const request = ++lookupRequest.current
    setStatus(`Looking up ${value}…`)
    try {
      const orders = await searchOrders(value)
      if (request !== lookupRequest.current) return
      if (!orders.length) {
        setReturnCase((current) => (current?.status === RETURN_STATUS.IDENTIFIED ? null : current))
        setStatus(`No order matches “${value}”. Check the identifier and try again.`)
        return
      }
      const order = pickOrder(orders, value)
      const item = pickItem(order, value)
      setReturnCase(provisionalReturn(order, item, value))
      setStatus(
        `Order ${order.id} found${order.items.length > 1 ? ` (matched ${item.product_name})` : ''}. Confirm it to begin the inspection.`,
      )
    } catch (error) {
      if (request !== lookupRequest.current) return
      if (!error.offline) {
        setStatus(error.message)
        return
      }
      setReturnCase(null)
      setStatus('Could not connect to the return database. Start the backend and try again.')
    }
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

  // Inspection and the final decision now share one screen. Older links that
  // still point at "review" are normalized to the combined second step.
  const openStep = (requestedStep, currentReturn = returnCase) => {
    const step = requestedStep === 'review' ? 'inspection' : requestedStep
    if (currentReturn?.demo) {
      setReturnCase(null)
      setLookup('')
      setStatus('')
      setScreen('identify')
      return
    }
    if (currentReturn === returnCase && canOpenStep(currentReturn, step)) {
      setScreen(step)
      return
    }
    if (step === 'identify') {
      startNewReturn()
      return
    }
    // Saved returns move forward through the server so its status stays in sync.
    if (currentReturn === returnCase && returnCase?.saved) {
      beginInspection()
      return
    }

    // Never invent a sample product when no case is open. A provisional lookup
    // must be confirmed from the identification screen before inspection.
    if (currentReturn?.pending) {
      setLookup(currentReturn.lookupIdentifier)
      setStatus('Confirm this item before starting the inspection.')
      setScreen('identify')
      return
    }

    startNewReturn()
  }

  // Confirming the order creates the return in the database, then starts the inspection.
  const beginInspection = async () => {
    if (creating) return
    let current = returnCase

    if (current.pending || (current.saved && current.status === RETURN_STATUS.IDENTIFIED)) {
      setCreating(true)
      setStatus(current.pending ? 'Creating the return…' : 'Starting the inspection…')
      try {
        if (current.pending) {
          const created = await createReturn({
            order_id: current.pending.orderId,
            order_item_id: current.pending.orderItemId,
            lookup_identifier: current.lookupIdentifier,
            station: user.station || null,
            reviewer_email: user.email,
          })
          applyServerReturn(created)
          current = fromServerReturn(created)
        }
        applyServerReturn(await setReturnStatus(current.id, RETURN_STATUS.INSPECTION_IN_PROGRESS))
        setStatus('')
        setScreen('inspection')
      } catch (error) {
        setStatus(`Could not start the return: ${error.message}`)
      } finally {
        setCreating(false)
      }
      return
    }

    setReturnCase((existing) => (
      existing.status === RETURN_STATUS.IDENTIFIED
        ? transitionReturn(existing, RETURN_STATUS.INSPECTION_IN_PROGRESS)
        : existing
    ))
    setScreen('inspection')
  }

  // The combined screen moves the case into awaiting-decision immediately
  // before recording the reviewer's final choice.
  const completeReturn = async (decision) => {
    let readyReturn = returnCase

    if (readyReturn?.status === RETURN_STATUS.INSPECTION_IN_PROGRESS) {
      if (readyReturn.saved) {
        try {
          const awaiting = await setReturnStatus(readyReturn.id, RETURN_STATUS.AWAITING_DECISION)
          readyReturn = fromServerReturn(awaiting)
        } catch (error) {
          return `Could not prepare the decision: ${error.message}`
        }
      } else {
        readyReturn = transitionReturn(readyReturn, RETURN_STATUS.AWAITING_DECISION)
      }
      setReturnCase(readyReturn)
    }

    if (readyReturn?.status !== RETURN_STATUS.AWAITING_DECISION) {
      return 'This return is not ready for a decision yet.'
    }

    let completedReturn
    if (readyReturn.saved) {
      const note = decision.note.trim()
      try {
        const saved = await recordDecision(readyReturn.id, {
          outcome: decision.type,
          reason: decision.type === 'approve' ? null : decision.reason || null,
          note: note || null,
          reviewer_email: user.email,
        })
        completedReturn = fromServerReturn(saved)
      } catch (error) {
        return `Could not save the decision: ${error.message}`
      }
    } else {
      completedReturn = transitionReturn(readyReturn, RETURN_STATUS.COMPLETED, {
        decision,
        activityLabel: `Decision recorded: ${decision.title}`,
      })
    }

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
    return null
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
    if (canOpenStep(returnCase, 'inspection')) setScreen('inspection')
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
                  <button type="button" onClick={beginInspection} disabled={creating}>
                    {creating ? 'Creating…' : returnCase.status === RETURN_STATUS.IDENTIFIED ? 'Begin inspection' : 'Continue return'}
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
      ) : (
        <ItemInspection
          returnCase={returnCase}
          onServerUpdate={applyServerReturn}
          onBack={() => openStep('identify')}
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

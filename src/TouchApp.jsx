import TouchIcon from './TouchIcon.jsx'
import { useEffect, useRef, useState } from 'react'
import chevron from './assets/figma/21c36.svg'
import { TouchReviewDecision as ReviewDecision, TouchVerification as ItemInspection } from './Touchscreen.jsx'
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
  transitionReturn,
} from './returnLifecycle.js'
import { createReturn, searchOrders, setReturnStatus } from './api.js'
import { fromServerReturn, pickItem, pickOrder } from './returnRecords.js'
import './App.css'
import './Touchscreen.css'

const SAMPLE_LOOKUP = 'ORD-8921'

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
  const [inspectionPanel, setInspectionPanel] = useState('evidence')
  const [returnCase, setReturnCase] = useState(null)
  const [preferences, setPreferences] = useState(() => loadPreferences(user.email))
  const [history, setHistory] = useState(() => loadDecisionHistory(user.email))

  const handleScannedCode = (code, product) => {
    if (preferences.scanSound) {
      const AudioContext = window.AudioContext || window.webkitAudioContext
      if (AudioContext) {
        const context = new AudioContext()
        const tone = context.createOscillator()
        const gain = context.createGain()
        tone.connect(gain)
        gain.connect(context.destination)
        gain.gain.value = 0.08
        tone.frequency.value = 880
        tone.start()
        tone.stop(context.currentTime + 0.1)
        tone.onended = () => { context.close() }
      }
    }
    const identified = createIdentifiedReturn(code)
    if (product) {
      identified.productName = product.name
      identified.productModel = ''
      identified.sku = product.sku || product.id
    }
    setReturnCase(transitionReturn(identified, RETURN_STATUS.INSPECTION_IN_PROGRESS))
    setInspectionPanel('evidence')
    setScreen('inspection')
  }

  const handleOrderLookup = async (identifier) => {
    const orders = await searchOrders(identifier)
    if (!orders.length) {
      throw new Error(`No order matches “${identifier}”. Check the number and try again.`)
    }

    const order = pickOrder(orders, identifier)
    const item = pickItem(order, identifier)
    const created = await createReturn({
      order_id: order.id,
      order_item_id: item.id,
      lookup_identifier: identifier,
      station: user.station || null,
      reviewer_email: user.email,
    })
    const started = await setReturnStatus(created.id, RETURN_STATUS.INSPECTION_IN_PROGRESS)
    setReturnCase(fromServerReturn(started))
    setInspectionPanel('evidence')
    setScreen('inspection')
  }

  // Evidence and the final decision are two panels within the same
  // "Inspect & decide" step on the touchscreen.
  const openStep = (step, currentReturn = returnCase) => {
    if (currentReturn === returnCase && canOpenStep(currentReturn, step)) {
      setInspectionPanel(step === 'review' ? 'decision' : 'evidence')
      setScreen(step === 'identify' ? 'identify' : 'inspection')
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
    setInspectionPanel(step === 'review' ? 'decision' : 'evidence')
    setScreen('inspection')
  }

  const continueToReview = (productName) => {
    setReturnCase((current) => (
      current.status === RETURN_STATUS.INSPECTION_IN_PROGRESS
        ? transitionReturn(current, RETURN_STATUS.AWAITING_DECISION, { productName })
        : { ...current, productName }
    ))
    setInspectionPanel('decision')
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
    }
    setInspectionPanel('evidence')
    setScreen('identify')
  }

  const resumeReturn = () => {
    if (canOpenStep(returnCase, 'review')) {
      setInspectionPanel('decision')
      setScreen('inspection')
    } else if (canOpenStep(returnCase, 'inspection')) {
      setInspectionPanel('evidence')
      setScreen('inspection')
    } else {
      setScreen('identify')
    }
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
    <div className="app-shell touchscreen">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#main" aria-label="ReturnScan home" onClick={() => openStep('identify')}>
            <span className="touch-logo"><TouchIcon /></span>
            <span>ReturnScan</span>
          </a>

          <div className="account-tools">

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
      <main id="main" className="touch-main">
        <BarcodeScanner
          autoStart={preferences.openCameraOnStart}
          onDetected={handleScannedCode}
          onOrderLookup={handleOrderLookup}
        />
      </main>
      ) : inspectionPanel === 'evidence' ? (
        <ItemInspection
          returnCase={returnCase}
          onBack={() => openStep('identify')}
          onContinue={continueToReview}
        />
      ) : (
        <ReviewDecision
          returnCase={returnCase}
          onIdentify={() => openStep('identify')}
          onBack={() => setInspectionPanel('evidence')}
          onSubmitDecision={completeReturn}
        />
      )}
      <footer className="touch-footer"><span>{screen === 'account' ? 'Preferences and decision history are saved in this browser, per account.' : screen === 'inspection' ? 'Demo station · Inspect & decide' : 'Demo station · Ready to identify a return'}</span><span>ReturnScan / {user.station}</span></footer>
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

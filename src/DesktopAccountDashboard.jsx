import scannerPlate from './assets/figma/3c26b.svg'
import scannerIcon from './assets/figma/1988b.svg'
import scalePlate from './assets/figma/a440e.svg'
import scaleIcon from './assets/figma/dd3fb.svg'
import { PROVIDER_LABELS } from './auth/authService.js'
import { RETURN_STATUS, getStatusLabel } from './returnLifecycle.js'
import './AccountDashboard.css'

const decisionTypes = [
  ['approve', 'Approved'],
  ['secondary', 'Secondary review'],
  ['fraud', 'Flagged as fraud'],
]

const workflowShortcuts = [
  ['identify', '1', 'Identify return', 'Scan or look up the item'],
  ['inspection', '2', 'Inspect item', 'Compare images and measurements'],
  ['review', '3', 'Review decision', 'Approve, escalate, or flag'],
]

const dateTimeFormat =new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const currencyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

function formatDateTime(value) {
  return dateTimeFormat.format(new Date(value))
}

function ProfileAvatar({ user, size = 'large' }) {
  return user.picture ? (
    <img className={`account-avatar ${size}`} src={user.picture} alt="" referrerPolicy="no-referrer" />
  ) : (
    <span className={`account-avatar ${size}`} aria-hidden="true">{user.initials}</span>
  )
}

function ToggleRow({ id, title, description, checked, onChange }) {
  return (
    <label className="preference-row" htmlFor={id}>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input
        id={id}
        className="toggle-input"
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true"><i /></span>
    </label>
  )
}

function AccountDashboard({
  session,
  activeReturn,
  history,
  preferences,
  onPreferencesChange,
  onClearHistory,
  onStartReturn,
  onResumeReturn,
  onOpenStep,
  onSignOut,
}) {
  const { user, provider, signedInAt, remember } = session
  const firstName = user.name.split(' ')[0]
  const counts = Object.fromEntries(decisionTypes.map(([type]) => [
    type,
    history.filter((entry) => entry.decision.type === type).length,
  ]))
  const approvedValue = history
    .filter((entry) => entry.decision.type === 'approve')
    .reduce((total, entry) => total + (entry.refundAmount || 0), 0)
  const inProgress = activeReturn && activeReturn.status !== RETURN_STATUS.COMPLETED

  const updatePreference = (key) => (value) => onPreferencesChange({ ...preferences, [key]: value })

  return (
    <main id="main" className="page-content account-page">
      <section className="intro account-intro" aria-labelledby="account-title">
        <div>
          <h1 id="account-title">Account dashboard</h1>
          <p>Welcome back, {firstName}. Review your activity, profile, and station preferences.</p>
        </div>
        <div className="account-intro-actions">
          <button type="button" className="account-secondary-button" onClick={onSignOut}>Sign out</button>
          <button type="button" className="account-primary-button" onClick={onStartReturn}>Start new return</button>
        </div>
      </section>

      <section className="account-stats" aria-label="Decision summary">
        <article className="stat-tile">
          <span>Returns completed</span>
          <strong>{history.length}</strong>
          <small>Recorded with this account</small>
        </article>
        {decisionTypes.map(([type, label]) => (
          <article className={`stat-tile ${type}`} key={type}>
            <span>{label}</span>
            <strong>{counts[type]}</strong>
            <small>
              {type === 'approve'
                ? `${currencyFormat.format(approvedValue)} refunded`
                : `${history.length ? Math.round((counts[type] / history.length) * 100) : 0}% of decisions`}
            </small>
          </article>
        ))}
      </section>

      <div className="account-grid">
        <div className="account-main-column">
          <section className="account-card current-return-card" aria-labelledby="current-return-title">
            <div className="account-card-heading">
              <div>
                <h2 id="current-return-title">Current return</h2>
                <p>Pick up where you left off at the station.</p>
              </div>
              <span className={`return-status-pill ${inProgress ? 'active' : 'idle'}`}>
                {inProgress ? getStatusLabel(activeReturn) : 'No open case'}
              </span>
            </div>
            {inProgress ? (
              <div className="current-return-body">
                <div>
                  <strong>{activeReturn.productName}</strong>
                  <small>{activeReturn.id} / Order #{activeReturn.orderNumber} / {activeReturn.productModel}</small>
                </div>
                <button type="button" className="account-primary-button" onClick={onResumeReturn}>Resume return</button>
              </div>
            ) : (
              <div className="current-return-body empty">
                <div>
                  <strong>Ready for the next item</strong>
                  <small>Scan a barcode or look up an order to open a return case.</small>
                </div>
                <button type="button" className="account-primary-button" onClick={onStartReturn}>Identify a return</button>
              </div>
            )}
            <div className="workflow-shortcuts" aria-label="Jump to a workflow step">
              {workflowShortcuts.map(([step, number, title, description]) => (
                <button type="button" key={step} onClick={() => onOpenStep(step)}>
                  <span className="step-number">{number}</span>
                  <span>
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="account-card" aria-labelledby="history-title">
            <div className="account-card-heading">
              <div>
                <h2 id="history-title">Recent decisions</h2>
                <p>Final decisions you recorded, newest first.</p>
              </div>
              {history.length ? (
                <button type="button" className="text-button" onClick={onClearHistory}>Clear history</button>
              ) : null}
            </div>
            {history.length ? (
              <ol className="decision-history">
                {history.slice(0, 8).map((entry) => (
                  <li key={`${entry.id}-${entry.completedAt}`}>
                    <span className={`decision-dot ${entry.decision.type}`} aria-hidden="true" />
                    <div className="decision-history-copy">
                      <strong>{entry.decision.title}</strong>
                      <small>{entry.productName} / {entry.id} / Order #{entry.orderNumber}</small>
                      {entry.decision.reason && entry.decision.type !== 'approve' ? (
                        <small className="decision-reason">Reason: {entry.decision.reason}</small>
                      ) : null}
                    </div>
                    <time dateTime={entry.completedAt}>{formatDateTime(entry.completedAt)}</time>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="empty-history">
                <strong>No decisions yet</strong>
                <small>Completed returns will appear here with their outcome and time.</small>
              </div>
            )}
          </section>
        </div>

        <aside className="account-side-column" aria-label="Account details">
          <section className="account-card profile-card" aria-labelledby="profile-title">
            <h2 id="profile-title" className="sr-only">Profile</h2>
            <div className="profile-summary">
              <ProfileAvatar user={user} />
              <div>
                <strong>{user.name}</strong>
                <small>{user.email}</small>
                <span className="role-badge">{user.role}</span>
              </div>
            </div>
            <dl className="profile-details">
              <div><dt>Station</dt><dd>{user.station}</dd></div>
              <div><dt>Signed in with</dt><dd>{PROVIDER_LABELS[provider]}</dd></div>
              <div><dt>Session started</dt><dd>{formatDateTime(signedInAt)}</dd></div>
              <div><dt>Session</dt><dd>{remember ? 'Kept on this device' : 'Ends when the browser closes'}</dd></div>
            </dl>
          </section>

          <section className="account-card" aria-labelledby="preferences-title">
            <h2 id="preferences-title">Station preferences</h2>
            <p className="account-card-note">Saved for this account on this device.</p>
            <div className="preference-row">
              <span>
                <strong>Default lookup method</strong>
                <small>Used when you start a new return.</small>
              </span>
              <div className="mode-switch compact" role="group" aria-label="Default lookup method">
                {[['barcode', 'Barcode'], ['order', 'Order ID']].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={preferences.defaultLookupMode === value ? 'active' : ''}
                    aria-pressed={preferences.defaultLookupMode === value}
                    onClick={() => updatePreference('defaultLookupMode')(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <ToggleRow
              id="pref-auto-detect"
              title="Scanner auto-detect"
              description="Start a lookup as soon as a code is read."
              checked={preferences.autoDetect}
              onChange={updatePreference('autoDetect')}
            />
            <ToggleRow
              id="pref-queue"
              title="Review queue badge"
              description="Show the count of cases waiting for review."
              checked={preferences.queueNotifications}
              onChange={updatePreference('queueNotifications')}
            />
          </section>

          <section className="account-card" aria-labelledby="account-devices-title">
            <h2 id="account-devices-title">Station devices</h2>
            <div className="device-row">
              <span className="layered-icon device-icon scanner-device">
                <img src={scannerPlate} alt="" />
                <img src={scannerIcon} alt="" />
              </span>
              <div><strong>Barcode scanner</strong><small>USB scanner / {user.station}</small></div>
              <span className="status-pill connected">Connected</span>
            </div>
            <div className="device-row">
              <span className="layered-icon device-icon scale-device">
                <img src={scalePlate} alt="" />
                <img src={scaleIcon} alt="" />
              </span>
              <div><strong>Smart scale</strong><small>Stable / Calibrated today</small></div>
              <span className="status-pill ready">Ready</span>
            </div>
          </section>

          <section className="account-card sign-out-card" aria-labelledby="sign-out-title">
            <div>
              <h2 id="sign-out-title">Sign out</h2>
              <p className="account-card-note">
                {inProgress
                  ? 'Signing out discards the return case that is still open.'
                  : 'End your session on this station.'}
              </p>
            </div>
            <button type="button" className="account-danger-button" onClick={onSignOut}>Sign out</button>
          </section>
        </aside>
      </div>
    </main>
  )
}

export { ProfileAvatar }
export default AccountDashboard

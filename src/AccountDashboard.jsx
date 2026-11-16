import { RETURN_STATUS, getStatusLabel } from './returnLifecycle.js'
import './AccountDashboard.css'

const decisionTypes = [
  ['approve', 'Approved'],
  ['secondary', 'Secondary review'],
  ['fraud', 'Flagged as fraud'],
]

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
})

function formatDateTime(value) {
  return timeFormat.format(new Date(value))
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
}) {
  const { user } = session
  const counts = Object.fromEntries(decisionTypes.map(([type]) => [
    type,
    history.filter((entry) => entry.decision.type === type).length,
  ]))
  const inProgress = activeReturn && activeReturn.status !== RETURN_STATUS.COMPLETED

  const updatePreference = (key) => (value) => onPreferencesChange({ ...preferences, [key]: value })

  return (
    <main id="main" className="page-content account-page">
      <section className="intro account-intro" aria-labelledby="account-title">
        <div>
          <h1 id="account-title">Account dashboard</h1>
          <p>Activity, active returns, and station preferences.</p>
        </div>
        <div className="account-intro-actions">
          <button type="button" className="account-secondary-button" onClick={onStartReturn}>← Back to scan</button>
        </div>
      </section>

      <section className="account-stats" aria-label="Decision summary">
        <article className="stat-tile">
          <span>Decisions</span>
          <strong>{history.length}</strong>
        </article>
        {decisionTypes.map(([type, label]) => (
          <article className={`stat-tile ${type}`} key={type}>
            <span>{label}</span>
            <strong>{counts[type]}</strong>
          </article>
        ))}
      </section>

      <div className="account-grid">
        <section className="account-card account-activity-card" aria-labelledby="history-title">
            <div className="account-card-heading">
              <div>
                <h2 id="history-title">Recent decisions</h2>
                <p>Newest activity from this station.</p>
              </div>
              {history.length ? (
                <button type="button" className="text-button" onClick={onClearHistory}>Clear</button>
              ) : null}
            </div>
            {history.length ? (
              <ol className="decision-history">
                {history.slice(0, 3).map((entry) => (
                  <li key={`${entry.id}-${entry.completedAt}`}>
                    <div className="decision-history-copy">
                      <strong>{entry.id}</strong>
                      <small>{entry.productName}</small>
                    </div>
                    <time dateTime={entry.completedAt}>{formatDateTime(entry.completedAt)}</time>
                    <span className={`decision-label ${entry.decision.type}`}>{entry.decision.title}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="empty-history">
                <strong>No decisions yet</strong>
                <small>Completed returns will appear here with their outcome and time.</small>
              </div>
            )}

            <div className={`account-open-return${inProgress ? ' active' : ''}`}>
              <div>
                <span>{inProgress ? 'Open return' : 'Ready for a new return'}</span>
                <strong>{inProgress ? activeReturn.productName : 'No return in progress'}</strong>
                {inProgress ? <small>{activeReturn.id} · {getStatusLabel(activeReturn)}</small> : null}
              </div>
              <button type="button" onClick={inProgress ? onResumeReturn : onStartReturn}>
                {inProgress ? 'Resume' : 'Start scan'}
              </button>
            </div>
        </section>

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
            <span className="profile-station">{user.station}</span>
          </section>

          <section className="account-card" aria-labelledby="preferences-title">
            <h2 id="preferences-title">Station preferences</h2>
            <div className="preference-row">
              <span>
                <strong>Default lookup method</strong>
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
              description="Begin when a code is read."
              checked={preferences.autoDetect}
              onChange={updatePreference('autoDetect')}
            />
          </section>
        </aside>
      </div>
    </main>
  )
}

export { ProfileAvatar }
export default AccountDashboard

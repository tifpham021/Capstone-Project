import { RETURN_STATUS, getStatusLabel } from './returnLifecycle.js'
import { PROVIDER_LABELS } from './auth/authService.js'

export function ProfileAvatar({ user }) {
  return user.picture ? <img className="touch-avatar" src={user.picture} alt="" /> : <span className="touch-avatar">{user.initials}</span>
}

export default function AccountDashboard({ session, activeReturn, history, preferences, onPreferencesChange, onStartReturn, onResumeReturn }) {
  const { user } = session
  const counts = ['approve', 'fraud', 'secondary'].map(type => history.filter(entry => entry.decision.type === type).length)
  const inProgress = activeReturn && activeReturn.status !== RETURN_STATUS.COMPLETED
  return <main id="main" className="touch-main touch-account">
    <div className="touch-row account-heading"><div><h1>Account dashboard</h1><p className="touch-subtitle">{history.length} decisions in this account</p></div><button className="touch-secondary" onClick={onStartReturn}>← Back to scan</button></div>
    <section className="touch-stats" aria-label="Decision summary">{['Decisions', 'Accepted', 'Declined', 'Escalated'].map((label, i) => <div className="touch-card touch-row" key={label}><span>{label}</span><strong>{i === 0 ? history.length : counts[i - 1]}</strong></div>)}</section>
    <div className="touch-account-grid"><div><section className="touch-card recent-decisions"><div className="touch-row"><h2>Recent decisions</h2><small>Latest activity</small></div>{history.length ? history.slice(0, 3).map(entry => <div className="decision-line" key={`${entry.id}-${entry.completedAt}`}><span>{entry.id}</span><time dateTime={entry.completedAt}>{new Date(entry.completedAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</time><span>{entry.decision.type === 'approve' ? 'Accepted' : entry.decision.type === 'secondary' ? 'Escalated' : 'Declined'}</span></div>) : <p className="empty-decisions">No decisions yet. Completed returns appear here.</p>}</section><button className="open-return" onClick={inProgress ? onResumeReturn : onStartReturn}><div><small>{inProgress ? 'Open return' : 'Ready for the next return'}</small><strong>{inProgress ? activeReturn.id : 'Identify a return'}</strong></div><span>{inProgress ? getStatusLabel(activeReturn) : 'Start scanning →'}</span></button></div><aside><section className="touch-card account-details"><h2>{user.name} · {user.role}</h2><p>{user.email}</p><small>{session.provider === 'email' ? 'Demo email session' : PROVIDER_LABELS[session.provider]} · {user.station}</small></section><section className="touch-card station-preferences"><h2>Station preferences</h2>{[['scanSound', 'Scan sound'], ['openCameraOnStart', 'Open camera on start']].map(([key, label]) => <label className="touch-row touch-preference" key={key}><span>{label}</span><input type="checkbox" role="switch" checked={Boolean(preferences[key])} onChange={e => onPreferencesChange({...preferences, [key]: e.target.checked})} /></label>)}</section></aside></div>
  </main>
}

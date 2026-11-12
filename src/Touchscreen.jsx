import TouchIcon from './TouchIcon.jsx'
import { useState } from 'react'
import preview from './assets/station-preview.png'
import { RETURN_STATUS } from './returnLifecycle.js'
import { evidenceSignals, latest, recommendation } from './returnRecords.js'

const touchDecisions = [
  { id: 'approve', title: 'Approve', detail: 'Refund', tone: 'approve' },
  { id: 'secondary', title: 'Review', detail: 'Escalate', tone: 'secondary' },
  { id: 'fraud', title: 'Flag', detail: 'Hold', tone: 'fraud' },
]

export function TouchVerification({ returnCase, onBack, onContinue }) {
  const [name, setName] = useState(returnCase.productName)
  const [editing, setEditing] = useState(false)
  return <main id="main" className="touch-main verification">
    <h1>Inspect &amp; decide</h1><p className="touch-subtitle">Review the item evidence before making the final decision.</p>
    <div className="verify-grid">
      <section className="touch-card verify-details">
        <div className="touch-row"><strong><TouchIcon /> Item verified</strong><span className="touch-pill">Visual + weight</span></div>
        <label htmlFor="item-name">Scanned return identity</label>
        <div className="identity-input"><input id="item-name" value={name} readOnly={!editing} onChange={e => setName(e.target.value)} /><button aria-label={editing ? 'Save item identity' : 'Edit item identity'} onClick={() => setEditing(!editing)}>{editing ? '✓' : '✎'}</button></div>
        <div className="weight-summary"><div className="touch-row"><strong>Weight comparison</strong><span className="touch-pill">99.4% Match</span></div><div className="touch-row"><span>Expected weight</span><strong>1.62 kg</strong></div><div className="touch-row"><span>Scale measured</span><strong>1.61 kg</strong></div></div>
      </section>
      <div className="verify-cameras">
        <section className="verify-camera">
          <div className="touch-row"><strong>Camera</strong><span className="touch-pill">Verified</span></div>
          <div className="evidence-preview" style={{backgroundImage: `url(${preview})`}}><span>▣ Illustrative camera preview</span></div>
        </section>
      </div>
    </div>
    <div className="verify-actions"><button className="touch-secondary" onClick={onBack}><TouchIcon /> Retry scan</button><button className="touch-primary" onClick={() => onContinue(name.trim() || returnCase.productName)}>Review decision →</button></div>
  </main>
}

export function TouchReviewDecision({ returnCase, onIdentify, onBack, onSubmitDecision }) {
  const [decision, setDecision] = useState(returnCase.decision?.type || 'secondary')
  const [reason, setReason] = useState(returnCase.decision?.reason || 'Missing serial / identity evidence')
  const [note, setNote] = useState(returnCase.decision?.note || '')
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const isComplete = returnCase.status === RETURN_STATUS.COMPLETED
  const savedSignals = returnCase.saved ? evidenceSignals(returnCase) : null
  const advice = savedSignals
    ? recommendation(savedSignals)
    : {
        title: 'Likely the same item',
        detail: 'Identity, camera views and weight are consistent. You make the final decision.',
      }
  const verification = returnCase.saved ? latest(returnCase.verifications) : null
  const confidence = returnCase.saved
    ? verification?.decision === 'inconclusive' ? null : verification ? Math.round(verification.confidence * 100) : null
    : 99
  const signals = savedSignals || [
    { key: 'identity', title: 'Item identity', detail: 'Verified', state: 'match' },
    { key: 'weight', title: 'Weight', detail: '99.4% match', state: 'match' },
    { key: 'photos', title: 'Camera views', detail: '2 captured', state: 'match' },
  ]
  const compactSignalLabels = {
    identity: 'Identity',
    weight: 'Weight',
    visual: 'Visual',
    photos: 'Photos',
  }
  const completedChecks = signals.filter((signal) => signal.state !== 'pending').length

  const submitDecision = async (event) => {
    event.preventDefault()
    if (submitting || isComplete) return
    if (decision !== 'approve' && !note.trim()) {
      setFeedback('Add a short note for the next reviewer.')
      return
    }

    const selected = touchDecisions.find((option) => option.id === decision)
    const title = decision === 'approve'
      ? 'Approve return'
      : decision === 'secondary'
        ? 'Request secondary review'
        : 'Flag as suspected fraud'
    setSubmitting(true)
    setFeedback('Saving decision…')
    const error = await onSubmitDecision({
      type: decision,
      title,
      reason: decision === 'approve' ? '' : reason,
      note: note.trim(),
    })
    setSubmitting(false)
    setFeedback(error || `${selected.title} decision recorded.`)
  }

  return <main id="main" className="touch-main touch-review">
    <div className="touch-review-heading">
      <div><h1>Review return</h1><p title={returnCase.productName}>{returnCase.productName}</p></div>
      <button type="button" className="touch-review-back" onClick={onBack}>‹ Back</button>
    </div>

    <div className="touch-review-grid">
      <section className="touch-card touch-review-summary" aria-labelledby="touch-result-title">
        <div className="touch-review-panel-heading"><h2>Analysis</h2><span>{returnCase.id}</span></div>
        <div className="touch-review-recommendation">
          <span className="touch-review-shield"><TouchIcon name="shield" /></span>
          <h2 id="touch-result-title">{advice.title}</h2>
          {confidence !== null ? <strong className="touch-review-confidence">{confidence}%<small>match</small></strong> : null}
        </div>
        <div className="touch-review-evidence-status">
          <div className="touch-review-checks-heading"><strong>Checks</strong><span>{completedChecks}/{signals.length} complete</span></div>
          <div className="touch-review-checks">
            {signals.map((signal) => <span className={signal.state} aria-label={`${signal.title}: ${signal.detail}`} title={signal.detail} key={signal.key}>
              <i>{signal.state === 'match' ? '✓' : signal.state === 'review' ? '!' : '·'}</i>
              <strong>{compactSignalLabels[signal.key] || signal.title}</strong>
              <small>{signal.state === 'match' ? 'Match' : signal.state === 'review' ? 'Review' : 'Missing'}</small>
            </span>)}
          </div>
        </div>
      </section>

      <form id="touch-review-form" className="touch-card touch-review-form" onSubmit={submitDecision}>
        <div className="touch-row"><h2>Final decision</h2><span className={`touch-review-status${isComplete ? ' complete' : ''}`}>{isComplete ? 'Done' : 'Required'}</span></div>
        <fieldset disabled={isComplete}>
          <legend className="sr-only">Final return decision</legend>
          <div className="touch-review-options">
            {touchDecisions.map((option) => <label className={`${option.tone}${decision === option.id ? ' selected' : ''}`} key={option.id}>
              <input type="radio" name="touch-decision" value={option.id} checked={decision === option.id} onChange={() => { setDecision(option.id); setFeedback('') }} />
              <span>{decision === option.id ? '●' : '○'}</span><strong>{option.title}</strong><small>{option.detail}</small>
            </label>)}
          </div>
        </fieldset>

        {decision === 'approve' ? <div className="touch-review-approval"><strong>Refund and close this return</strong></div> : <div className="touch-review-fields">
          <label><span>Reason</span><select value={reason} onChange={(event) => setReason(event.target.value)} disabled={isComplete}>
            <option>Missing serial / identity evidence</option>
            <option>Visual evidence is inconclusive</option>
            <option>Weight measurement is inconsistent</option>
            <option>Suspected item substitution</option>
          </select></label>
          <label><span>Note</span><input value={note} onChange={(event) => { setNote(event.target.value); setFeedback('') }} placeholder="Add a short note" disabled={isComplete} /></label>
        </div>}
        <div className="touch-review-submit-row">
          {feedback || isComplete ? <p className="touch-review-feedback" role="status">{feedback || `${returnCase.decision.title} was recorded.`}</p> : null}
          {isComplete
            ? <button type="button" className="touch-primary" onClick={onIdentify}>Start next return</button>
            : <button type="submit" className="touch-primary" disabled={submitting}>{submitting ? 'Saving…' : decision === 'approve' ? 'Approve return' : decision === 'fraud' ? 'Flag return' : 'Send for review'}</button>}
        </div>
      </form>
    </div>
  </main>
}

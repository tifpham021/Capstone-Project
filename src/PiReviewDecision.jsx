import { useState } from 'react'
import { artifactUrl } from './scanApi.js'
import { RETURN_STATUS } from './returnLifecycle.js'
import './PiReviewDecision.css'

const decisions = [
  {
    id: 'approve',
    title: 'Approve return',
    description: 'Issue the refund and close the case.',
    badge: 'Refund',
  },
  {
    id: 'secondary',
    title: 'Request secondary review',
    description: 'Route unresolved evidence to another reviewer.',
    badge: 'Selected',
  },
  {
    id: 'fraud',
    title: 'Flag suspected fraud',
    description: 'Hold the refund and send for investigation.',
    badge: 'Hold',
  },
]

function formatKilograms(grams) {
  if (!Number.isFinite(grams)) return 'Not available'
  return `${(grams / 1000).toFixed(3)} kg`
}

function visualResultLabel(decision) {
  if (decision === 'consistent') return 'Likely the same product'
  if (decision === 'suspicious') return 'Differences detected'
  return 'Needs reviewer attention'
}

function evidenceTone(ready, needsReview = false) {
  if (!ready) return 'pending'
  return needsReview ? 'review' : 'ready'
}

function ReviewDecision({ scan, returnCase, onBack, onSubmitDecision, reviewerName }) {
  const [decision, setDecision] = useState(returnCase.decision?.type || 'secondary')
  const [reason, setReason] = useState(returnCase.decision?.reason || 'Missing serial / identity evidence')
  const [feedback, setFeedback] = useState('')
  const isComplete = returnCase.status === RETURN_STATUS.COMPLETED

  const resultEntry = scan?.results?.find((entry) => entry.result) || scan?.results?.[0]
  const verification = resultEntry?.result
  const cameraImagePath = verification?.annotated_image_url
    || verification?.original_image_url
    || verification?.normalized_image_url
  const cameraImage = artifactUrl(cameraImagePath)
  const visualDecision = verification?.decision
  const confidence = verification?.confidence_percent
  const weight = scan?.weight
  const visualReady = Boolean(verification)
  const weightReady = Boolean(weight)
  const visualNeedsReview = visualReady && visualDecision !== 'consistent'
  const weightNeedsReview = weightReady && !weight.within_tolerance
  const firstWarning = verification?.warnings?.[0]
    || (visualNeedsReview ? verification?.reasons?.[0] : '')
    || (weightNeedsReview ? 'Measured weight is outside the expected tolerance.' : '')
  const reviewerCheck = firstWarning || 'Verify the item markings before approving.'

  const submitDecision = (event) => {
    event.preventDefault()
    const title = decisions.find((option) => option.id === decision)?.title
    onSubmitDecision({ type: decision, title, reason, note: '' })
    setFeedback(`${title} recorded for ${returnCase.id}.`)
  }

  return (
    <>
      <main id="main" className="review-page">
        <section className="review-intro" aria-labelledby="review-title">
          <div>
            <h1 id="review-title">Review &amp; decide</h1>
            <p>Review the scan results, then record the final outcome.</p>
          </div>
          <div className="review-case-summary" aria-label="Return case summary">
            <div>
              <span>Return case</span>
              <strong>{returnCase.id}</strong>
            </div>
            <div>
              <span>Expected product</span>
              <strong>{returnCase.productName}</strong>
              {returnCase.productModel && <small>{returnCase.productModel}</small>}
            </div>
          </div>
        </section>

        <div className="review-layout">
          <section className="review-analysis-card" aria-labelledby="analysis-summary-title">
            <header className="review-section-heading">
              <div>
                <h2 id="analysis-summary-title">Analysis summary</h2>
                <p>Camera evidence and the two checks used for this return.</p>
              </div>
            </header>

            <div className="review-analysis-grid">
              <div className="review-camera-section">
                <span className="review-eyebrow">Camera evidence</span>
                <figure className="review-camera-preview">
                  <span className="review-capture-label"><i />Captured</span>
                  {cameraImage ? (
                    <a href={cameraImage} target="_blank" rel="noreferrer" aria-label="Open captured item image">
                      <img src={cameraImage} alt="Captured returned item" />
                    </a>
                  ) : (
                    <div className="review-camera-placeholder">
                      <span aria-hidden="true" />
                      <strong>Camera capture unavailable</strong>
                    </div>
                  )}
                  <span className="review-camera-count">{scan?.results?.length || 0} camera capture</span>
                </figure>
                <p className="review-camera-caption">Captured automatically after order confirmation</p>
              </div>

              <div className="review-results-panel">
                <header>
                  <span>Analysis results</span>
                  <small>AI results are advisory</small>
                </header>

                <section className={`review-result-row ${evidenceTone(visualReady, visualNeedsReview)}`}>
                  <i aria-hidden="true">{visualReady ? (visualNeedsReview ? '!' : '✓') : '—'}</i>
                  <div>
                    <span>Visual match</span>
                    <strong>{visualResultLabel(visualDecision)}</strong>
                  </div>
                  <b>{Number.isFinite(confidence) ? `${confidence.toFixed(0)}%` : 'Not available'}</b>
                </section>

                <section className={`review-result-row ${evidenceTone(weightReady, weightNeedsReview)}`}>
                  <i aria-hidden="true">{weightReady ? (weightNeedsReview ? '!' : '✓') : '—'}</i>
                  <div>
                    <span>Weight check</span>
                    <strong>{formatKilograms(weight?.expected_weight_g)} → {formatKilograms(weight?.measured_weight_g)}</strong>
                  </div>
                  <b>{Number.isFinite(weight?.difference_g) ? `${weight.difference_g >= 0 ? '+' : ''}${(weight.difference_g / 1000).toFixed(3)} kg` : 'Not available'}</b>
                </section>

                <div className="review-results-note">
                  <span aria-hidden="true">!</span>
                  <p>{reviewerCheck}</p>
                </div>
              </div>
            </div>
          </section>

          <form id="review-decision-form" className="review-decision-card" onSubmit={submitDecision}>
            <header className="review-section-heading">
              <div><h2>Final decision</h2><p>The reviewer makes the final call.</p></div>
              <span className={`decision-required-pill${isComplete ? ' completed' : ''}`}>{isComplete ? 'Completed' : 'Decision required'}</span>
            </header>

            <fieldset disabled={isComplete}>
              <legend className="sr-only">Final decision</legend>
              {decisions.map((option) => (
                <label className={`decision-option ${decision === option.id ? 'selected' : ''} ${option.id}`} key={option.id}>
                  <input
                    type="radio"
                    name="decision"
                    value={option.id}
                    checked={decision === option.id}
                    onChange={() => setDecision(option.id)}
                  />
                  <span className="decision-radio"><i /></span>
                  <span><strong>{option.title}</strong></span>
                  <b>{decision === option.id && option.id === 'secondary' ? 'Selected' : option.badge}</b>
                </label>
              ))}
            </fieldset>

            {decision !== 'approve' && (
              <>
                <label className="decision-field">
                  <span>{decision === 'fraud' ? 'Reason for flag' : 'Reason for review'}</span>
                  <select value={reason} onChange={(event) => setReason(event.target.value)} disabled={isComplete}>
                    <option>Missing serial / identity evidence</option>
                    <option>Visual evidence is inconclusive</option>
                    <option>Weight measurement is inconsistent</option>
                    <option>Suspected item substitution</option>
                  </select>
                </label>

              </>
            )}

            <div className="review-advisory-note">
              <span>i</span>
              <p>AI recommendation is advisory. Your decision is recorded.</p>
            </div>
            <span className="audit-note">Reviewer: {reviewerName}</span>
          </form>
        </div>
      </main>

      <footer className="review-footer">
        <div className="review-confirmation">
          <strong>{isComplete ? 'Decision recorded' : 'Analysis complete — reviewer decision required'}</strong>
          <small aria-live="polite">{feedback || (isComplete ? `${returnCase.decision.title} completed this return.` : 'The evidence is ready. Review the results and submit one final outcome.')}</small>
        </div>
        <div className="review-actions">
          <button type="button" className="back-button" onClick={onBack}>← Back to scan</button>
          <button type="submit" form="review-decision-form" className="submit-review-button" disabled={isComplete}>
            {isComplete ? 'Decision recorded' : decision === 'approve' ? 'Approve return' : decision === 'fraud' ? 'Flag return' : 'Send for review'} <span aria-hidden="true">→</span>
          </button>
        </div>
      </footer>
    </>
  )
}

export default ReviewDecision

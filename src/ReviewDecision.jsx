import { useState } from 'react'
import shippedReference from './assets/figma/inspection/4036d.png'
import returnedItem from './assets/figma/inspection/97c93.png'
import completeCircle from './assets/figma/inspection/b6992.svg'
import completeCheck from './assets/figma/inspection/c8145.svg'
import activeCircle from './assets/figma/inspection/6279e.svg'
import shieldCircle from './assets/figma/inspection/57345.svg'
import shieldCheck from './assets/figma/inspection/702ae.svg'
import warningCircle from './assets/figma/inspection/4633e.svg'
import warningMark from './assets/figma/inspection/630e0.svg'
import continueArrow from './assets/figma/inspection/d859a.svg'
import './ReviewDecision.css'

const decisions = [
  {
    id: 'approve',
    title: 'Approve return',
    description: 'Issue the $129.00 refund and close the case.',
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
    title: 'Flag as suspected fraud',
    description: 'Hold the refund and send the case to investigation.',
    badge: 'Hold',
  },
]

const signals = [
  ['Weight: 1.61 kg / 1.62 kg', 'Match'],
  ['Product geometry', 'Match'],
  ['Visual angle', 'Review'],
  ['Serial markings', 'Not captured'],
]

function ReviewAsset({ className = '', children }) {
  return <span className={`review-asset ${className}`}>{children}</span>
}

function CompletedStep({ title, detail, onClick, label }) {
  return (
    <li className="review-step complete">
      <button type="button" onClick={onClick} aria-label={label}>
        <ReviewAsset className="review-step-icon complete-icon">
          <img src={completeCircle} alt="" />
          <img src={completeCheck} alt="" />
        </ReviewAsset>
        <span><strong>{title}</strong><small>{detail}</small></span>
      </button>
    </li>
  )
}

function ReviewWorkflow({ onIdentify, onInspection }) {
  return (
    <ol className="review-workflow" aria-label="Return workflow">
      <CompletedStep
        title="Identify return"
        detail="Return and order verified"
        onClick={onIdentify}
        label="Back to product identification"
      />
      <CompletedStep
        title="Inspect item"
        detail="Evidence captured and analyzed"
        onClick={onInspection}
        label="Back to item inspection"
      />
      <li className="review-step current" aria-current="step">
        <span className="review-step-content">
          <ReviewAsset className="review-step-icon">
            <img src={activeCircle} alt="" />
            <b>3</b>
          </ReviewAsset>
          <span><strong>Review decision</strong><small>Human approval is required</small></span>
        </span>
      </li>
    </ol>
  )
}

function ReviewDecision({ onIdentify, onBack }) {
  const [decision, setDecision] = useState('secondary')
  const [reason, setReason] = useState('Missing serial / identity evidence')
  const [note, setNote] = useState('')
  const [feedback, setFeedback] = useState('')

  const submitDecision = (event) => {
    event.preventDefault()
    const title = decisions.find((option) => option.id === decision)?.title
    setFeedback(`${title} recorded for RORD-8921.`)
  }

  return (
    <>
      <main id="main" className="review-page">
        <ReviewWorkflow onIdentify={onIdentify} onInspection={onBack} />

        <section className="review-intro" aria-labelledby="review-title">
          <div>
            <h1 id="review-title">Review and decide</h1>
            <p>Review the evidence package and record a final return decision.</p>
          </div>
          <div className="review-case">
            <div>
              <span>Return case</span>
              <strong>RORD-8921</strong>
              <small>20V Cordless Drill / Model CD20</small>
            </div>
            <span className="decision-due"><i />Decision due</span>
          </div>
        </section>

        <div className="review-dashboard">
          <div className="review-main-column">
            <section className="recommendation-card" aria-labelledby="recommendation-title">
              <ReviewAsset className="recommendation-icon">
                <img src={shieldCircle} alt="" />
                <img src={shieldCheck} alt="" />
              </ReviewAsset>
              <div>
                <span>System recommendation</span>
                <h2 id="recommendation-title">Likely authentic - one check remains</h2>
                <p>Weight and geometry align. Serial markings were not captured, so human judgment remains required.</p>
              </div>
              <div className="confidence-score">
                <strong>86%</strong>
                <span>Match confidence</span>
                <i><b /></i>
              </div>
            </section>

            <section className="review-evidence-card" aria-labelledby="evidence-title">
              <div className="review-card-heading">
                <h2 id="evidence-title">Evidence package</h2>
                <span><i />Saved at 10:42</span>
              </div>

              <dl className="evidence-metadata">
                <div><dt>Order</dt><dd>#ORD-8921</dd></div>
                <div><dt>SKU</dt><dd>DRL-20V-KIT</dd></div>
                <div><dt>Serial</dt><dd>DT20-8821-K7</dd></div>
                <div><dt>Refund</dt><dd>$129.00</dd></div>
                <div><dt>Customer</dt><dd>Jane Doe</dd></div>
              </dl>

              <div className="evidence-review-grid">
                <figure>
                  <img src={shippedReference} alt="Verified shipped cordless drill reference" />
                  <figcaption><i />Shipped reference</figcaption>
                </figure>
                <figure>
                  <img src={returnedItem} alt="Live photo of the returned cordless drill" />
                  <figcaption><i />Returned item</figcaption>
                </figure>
                <div className="verification-signals">
                  <h3>Verification signals</h3>
                  {signals.map(([label, status]) => (
                    <div key={label}>
                      <span className={status === 'Match' ? 'signal-check' : 'signal-alert'}>
                        {status === 'Match' ? '✓' : '!'}
                      </span>
                      <span>{label}</span>
                      <strong>{status}</strong>
                    </div>
                  ))}
                </div>
              </div>

              <div className="review-attention">
                <ReviewAsset>
                  <img src={warningCircle} alt="" />
                  <img src={warningMark} alt="" />
                </ReviewAsset>
                <div><strong>Reviewer attention</strong><span>Capture the battery-bay serial plate or document why the available evidence is sufficient.</span></div>
                <button type="button" onClick={onBack}>View inspection</button>
              </div>
            </section>

            <section className="activity-card" aria-labelledby="activity-title">
              <h2 id="activity-title">Case activity</h2>
              <ol>
                <li className="done"><i /><span>10:36 - Return identified</span></li>
                <li className="done"><i /><span>10:39 - Evidence captured</span></li>
                <li className="done"><i /><span>10:42 - Analysis complete</span></li>
                <li className="current"><i /><span>Now - Awaiting decision</span></li>
              </ol>
            </section>
          </div>

          <form id="review-decision-form" className="decision-card" onSubmit={submitDecision}>
            <h2>Record final decision</h2>
            <p>Choose the outcome supported by the evidence.</p>
            <div className="advisory-note">
              <span>i</span>
              <div><strong>AI signals are advisory only.</strong><small>Your decision and rationale become the audit record.</small></div>
            </div>

            <fieldset>
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
                  <span><strong>{option.title}</strong><small>{option.description}</small></span>
                  <b>{decision === option.id && option.id === 'secondary' ? 'Selected' : option.badge}</b>
                </label>
              ))}
            </fieldset>

            <label className="decision-field">
              <span>Reason for escalation</span>
              <select value={reason} onChange={(event) => setReason(event.target.value)}>
                <option>Missing serial / identity evidence</option>
                <option>Visual evidence is inconclusive</option>
                <option>Weight measurement is inconsistent</option>
                <option>Suspected item substitution</option>
              </select>
            </label>

            <label className="decision-field decision-note">
              <span>Decision note</span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Explain what the next reviewer should verify..."
              />
              <small>{decision === 'approve' ? 'Optional for approvals' : 'Required for escalations and fraud flags'}</small>
            </label>

            <span className="audit-note">Reviewer: Jane Doe / Every decision is recorded in the audit log.</span>
          </form>
        </div>
      </main>

      <footer className="review-footer">
        <div className="review-confirmation">
          <span>✓</span>
          <div><strong>Final action requires confirmation</strong><small aria-live="polite">{feedback || 'The selected outcome will be recorded in the case audit log.'}</small></div>
        </div>
        <div className="review-actions">
          <button type="button" className="back-button" onClick={onBack}>‹&nbsp; Back to inspection</button>
          <button type="submit" form="review-decision-form" className="submit-review-button">
            Send for review
            <img src={continueArrow} alt="" />
          </button>
        </div>
      </footer>
    </>
  )
}

export default ReviewDecision

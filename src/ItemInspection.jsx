import { useState } from 'react'
import shippedReference from './assets/figma/inspection/4036d.png'
import returnedItem from './assets/figma/inspection/97c93.png'
import completeCircle from './assets/figma/inspection/b6992.svg'
import completeCheck from './assets/figma/inspection/c8145.svg'
import activeCircle from './assets/figma/inspection/6279e.svg'
import pendingCircle from './assets/figma/inspection/90707.svg'
import warningCircle from './assets/figma/inspection/4633e.svg'
import warningMark from './assets/figma/inspection/630e0.svg'
import checkCircle from './assets/figma/inspection/488b8.svg'
import checkMark from './assets/figma/inspection/3a161.svg'
import neutralCircle from './assets/figma/inspection/08f92.svg'
import neutralDot from './assets/figma/inspection/140bd.svg'
import shieldCircle from './assets/figma/inspection/57345.svg'
import shieldCheck from './assets/figma/inspection/702ae.svg'
import continueArrow from './assets/figma/inspection/d859a.svg'
import './ItemInspection.css'

const checks = [
  {
    title: 'Weight consistency',
    detail: '99% match to shipped measurement',
    state: 'match',
  },
  {
    title: 'Product geometry',
    detail: 'Housing and battery proportions align',
    state: 'match',
  },
  {
    title: 'Visual similarity',
    detail: 'Different angle limits confidence',
    state: 'review',
  },
  {
    title: 'Serial / markings',
    detail: 'Capture battery-bay label to complete check',
    state: 'pending',
  },
]

function StackedAsset({ className = '', children }) {
  return <span className={`inspection-asset ${className}`}>{children}</span>
}

function InspectionWorkflow({ onBack, onContinue }) {
  return (
    <ol className="inspection-workflow" aria-label="Return workflow">
      <li className="inspection-step complete">
        <button type="button" onClick={onBack} aria-label="Back to product identification">
          <StackedAsset className="inspection-step-icon complete-icon">
            <img src={completeCircle} alt="" />
            <img src={completeCheck} alt="" />
          </StackedAsset>
          <span><strong>Identify return</strong><small>Return and order verified</small></span>
        </button>
      </li>
      <li className="inspection-step current" aria-current="step">
        <span className="inspection-step-content">
          <StackedAsset className="inspection-step-icon">
            <img src={activeCircle} alt="" />
            <b>2</b>
          </StackedAsset>
          <span><strong>Inspect item</strong><small>Compare images and measurements</small></span>
        </span>
      </li>
      <li className="inspection-step upcoming">
        <button type="button" onClick={onContinue} aria-label="Open final review">
          <StackedAsset className="inspection-step-icon">
            <img src={pendingCircle} alt="" />
            <b>3</b>
          </StackedAsset>
          <span><strong>Review decision</strong><small>Approve, escalate, or flag</small></span>
        </button>
      </li>
    </ol>
  )
}

function StatusIcon({ state }) {
  if (state === 'match') {
    return (
      <StackedAsset className="check-state-icon">
        <img src={checkCircle} alt="" />
        <img src={checkMark} alt="" />
      </StackedAsset>
    )
  }

  if (state === 'review') {
    return (
      <StackedAsset className="check-state-icon warning-state-icon">
        <img src={warningCircle} alt="" />
        <img src={warningMark} alt="" />
      </StackedAsset>
    )
  }

  return (
    <StackedAsset className="check-state-icon">
      <img src={neutralCircle} alt="" />
      <img src={neutralDot} alt="" />
    </StackedAsset>
  )
}

function ItemInspection({ onBack, onContinue }) {
  const [note, setNote] = useState('')
  const [photoCount, setPhotoCount] = useState(2)
  const [weight, setWeight] = useState('1.61')
  const [feedback, setFeedback] = useState('')

  const addPhoto = () => {
    setPhotoCount((count) => Math.min(count + 1, 4))
    setFeedback('Photo slot added to the evidence package.')
  }

  const toggleTare = () => {
    const tared = weight === '0.00'
    setWeight(tared ? '1.61' : '0.00')
    setFeedback(tared ? 'Live scale reading restored.' : 'Scale tared successfully.')
  }

  return (
    <>
      <main id="main" className="inspection-page">
        <InspectionWorkflow onBack={onBack} onContinue={onContinue} />

        <section className="inspection-intro" aria-labelledby="inspection-title">
          <div>
            <h1 id="inspection-title">Inspect the returned item</h1>
            <p>Compare the live return against the verified shipment before making a decision.</p>
          </div>
          <div className="inspection-case">
            <div>
              <span>Return case</span>
              <strong>RORD-8921</strong>
              <small>20V Cordless Drill / Model CD20</small>
            </div>
            <span className="needs-review"><i />Needs review</span>
          </div>
        </section>

        <div className="inspection-dashboard">
          <section className="comparison-card" aria-labelledby="comparison-title">
            <div className="comparison-heading">
              <h2 id="comparison-title">Visual comparison</h2>
              <span>{photoCount} images synced</span>
            </div>

            <div className="comparison-images">
              <figure>
                <img src={shippedReference} alt="Verified shipped cordless drill reference" />
                <figcaption className="image-label reference-label"><i />Shipped reference</figcaption>
                <span className="image-count">01 / 04</span>
              </figure>
              <figure>
                <img src={returnedItem} alt="Live photo of the returned cordless drill" />
                <figcaption className="image-label returned-label"><i />Returned item</figcaption>
                <span className="image-count live-count">Live</span>
              </figure>
            </div>

            <div className="attention-panel">
              <StackedAsset className="attention-icon">
                <img src={warningCircle} alt="" />
                <img src={warningMark} alt="" />
              </StackedAsset>
              <div>
                <strong>Photo angle needs attention</strong>
                <p>Product shape appears consistent. Add a clear serial-plate photo to complete the check.</p>
              </div>
              <button type="button" onClick={addPhoto}><span>＋</span>Add photo</button>
            </div>

            <label className="inspection-note">
              <span>Inspection note</span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Add observations about packaging, wear, serial markings, or unusual details..."
              />
              <small>Notes will be included in the final review record.</small>
            </label>
          </section>

          <aside className="inspection-sidebar" aria-label="Automated inspection results">
            <section className="weight-card">
              <div className="weight-heading">
                <h2>Live weight check</h2>
                <span className="stable-pill"><i />Live and stable</span>
              </div>
              <div className="weight-reading">
                <div className="current-weight">
                  <strong>{weight}</strong><b>kg</b>
                  <span>Current scale reading</span>
                </div>
                <div className="expected-weight">
                  <span>Expected</span>
                  <strong>1.62 kg</strong>
                  <span>Delta <b>{weight === '0.00' ? '-1.62 kg' : '-0.01 kg'}</b></span>
                </div>
              </div>
              <div className="tolerance-bar">
                <span>✓</span>
                <strong>Within +/-0.05 kg tolerance</strong>
                <button type="button" onClick={toggleTare}>{weight === '0.00' ? 'Use live reading' : 'Tare scale'}</button>
              </div>
            </section>

            <section className="automated-card">
              <div className="automated-heading">
                <h2>Automated checks</h2>
                <span>3 of 4 complete</span>
              </div>
              <div className="checks-list">
                {checks.map((check) => (
                  <div className="check-row" key={check.title}>
                    <StatusIcon state={check.state} />
                    <div><strong>{check.title}</strong><small>{check.detail}</small></div>
                    <span className={`check-pill ${check.state}`}>{check.state}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="preserved-card">
              <StackedAsset className="preserved-icon">
                <img src={shieldCircle} alt="" />
                <img src={shieldCheck} alt="" />
              </StackedAsset>
              <div>
                <h2>Evidence package is preserved</h2>
                <p>Images, readings, and reviewer notes will carry into the decision.</p>
              </div>
              <span className="autosaved-pill">Auto-saved</span>
            </section>
          </aside>
        </div>
      </main>

      <footer className="inspection-footer">
        <div>
          <strong>2 checks need attention</strong>
          <span aria-live="polite">{feedback || 'You can continue now or add the recommended photos for higher confidence.'}</span>
        </div>
        <div className="inspection-actions">
          <button type="button" className="save-button" onClick={() => setFeedback('Inspection saved for later.')}>Save for later</button>
          <button type="button" className="continue-button" onClick={onContinue}>
            Continue to review
            <img src={continueArrow} alt="" />
          </button>
        </div>
      </footer>
    </>
  )
}

export default ItemInspection

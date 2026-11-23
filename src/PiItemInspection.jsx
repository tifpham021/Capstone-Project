import { useEffect, useRef, useState } from 'react'
import { artifactUrl, scanRequest } from './scanApi.js'
import './PiItemInspection.css'
import './OrderScan.css'

const stages = [
  ['ready', 'Ready'],
  ['scanning', 'Scanning'],
  ['complete', 'Complete'],
]

function formatWeight(grams) {
  if (!Number.isFinite(grams)) return 'Not available'
  return `${(grams / 1000).toFixed(3)} kg`
}

function decisionLabel(decision) {
  if (decision === 'consistent') return 'Match found'
  if (decision === 'suspicious') return 'Review needed'
  if (decision) return 'Inconclusive'
  return 'Waiting'
}

function CameraEmptyState({ pending, failed }) {
  return (
    <div className={`desktop-camera-empty${pending ? ' scanning' : ''}`}>
      <span className="desktop-camera-icon" aria-hidden="true"><i /></span>
      <strong>{failed ? 'Scan needs attention' : pending ? 'Scanning item…' : 'Place item in camera view'}</strong>
      <p>{failed ? 'Check the message below, then try again.' : pending ? 'Keep the item still while the camera captures it.' : 'Keep the full product visible inside the guide.'}</p>
      <span className="desktop-camera-guide" aria-hidden="true" />
    </div>
  )
}

function ScanProgress({ activeStage }) {
  const activeIndex = stages.findIndex(([stage]) => stage === activeStage)
  return (
    <ol className="desktop-scan-progress" aria-label="Inspection status">
      {stages.map(([stage, label], index) => {
        const finished = index < activeIndex || activeStage === 'complete'
        return (
          <li className={`${index === activeIndex ? 'active' : ''}${finished ? ' finished' : ''}`} key={stage}>
            <span aria-hidden="true">{finished ? '✓' : index + 1}</span>
            <strong>{label}</strong>
          </li>
        )
      })}
    </ol>
  )
}

export default function ItemInspection({ onBack, onContinue, scan, onScanChange }) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [orderNumber, setOrderNumber] = useState('')
  const [orderError, setOrderError] = useState('')
  const [lookingUp, setLookingUp] = useState(false)
  const dialogRef = useRef(null)
  const orderInputRef = useRef(null)
  const lookupRef = useRef(null)
  const scanId = scan?.scan_id
  const pending = scan?.status === 'queued' || scan?.status === 'processing'
  const busy = submitting || pending
  const complete = scan?.status === 'complete'
  const failed = Boolean(error || scan?.error || scan?.status === 'error')
  const stage = busy ? 'scanning' : complete ? 'complete' : 'ready'
  const resultEntry = scan?.results?.find((entry) => entry.result) || scan?.results?.[0]
  const verification = resultEntry?.result
  const cameraImagePath = verification?.annotated_image_url
    || verification?.original_image_url
    || verification?.normalized_image_url
  const cameraImage = artifactUrl(cameraImagePath)
  const referenceImagePath = verification?.annotated_reference_image_url
    || verification?.reference_image_url
    || verification?.normalized_reference_image_url
  const referenceImage = artifactUrl(referenceImagePath)
  const visualDecision = verification?.decision
  const photoCount = scan?.results?.length || 0

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialogOpen) {
      dialog.showModal()
      orderInputRef.current?.focus()
    }
    else dialog.close()
    return () => { if (dialog.open) dialog.close() }
  }, [dialogOpen])

  useEffect(() => () => lookupRef.current?.abort(), [])

  function openOrderDialog() {
    setOrderNumber(scan?.order?.order_number || '')
    setOrderError('')
    setDialogOpen(true)
  }

  function closeOrderDialog() {
    if (submitting) return
    lookupRef.current?.abort()
    setLookingUp(false)
    setDialogOpen(false)
  }

  function changeOrderNumber(value) {
    lookupRef.current?.abort()
    setLookingUp(false)
    setOrderError('')
    setOrderNumber(value)
  }

  function enterKeypadDigit(digit) {
    changeOrderNumber(`${orderNumber}${digit}`.slice(0, 64))
    orderInputRef.current?.focus()
  }

  function removeKeypadDigit() {
    changeOrderNumber(orderNumber.slice(0, -1))
    orderInputRef.current?.focus()
  }

  useEffect(() => {
    if (!pending || !scanId) return undefined
    const controller = new AbortController()
    let timer
    async function poll() {
      try {
        const next = await scanRequest(`/v1/cameras/scans/${scanId}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        setError('')
        onScanChange(next)
        if (next.status === 'complete' || next.status === 'error') return
      } catch (err) {
        if (controller.signal.aborted) return
        setError(`Cannot check scan: ${err.message}`)
        // A restart evicts jobs; allow a fresh scan instead of polling forever.
        if (err.message.includes('Scan not found')) {
          onScanChange({ scan_id: scanId, status: 'error', error: 'Scan expired. Start a new scan.' })
          return
        }
      }
      timer = setTimeout(poll, 1000)
    }
    poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [pending, scanId, onScanChange])

  async function startScan(event) {
    event.preventDefault()
    const number = orderNumber.trim()
    if (!number || submitting) return
    const controller = new AbortController()
    lookupRef.current = controller
    setSubmitting(true)
    setLookingUp(true)
    setError('')
    setOrderError('')
    try {
      const order = await scanRequest(`/v1/cameras/orders/${encodeURIComponent(number)}`, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (!order.reference_count) throw new Error('No reference photos are enrolled for this item. Add references before scanning.')
      setLookingUp(false)
      const next = await scanRequest('/v1/cameras/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_number: order.order_number }),
      })
      onScanChange(next)
      setDialogOpen(false)
    } catch (err) {
      if (!controller.signal.aborted) setOrderError(err.message)
    } finally {
      setSubmitting(false)
      setLookingUp(false)
    }
  }

  return (
    <>
      <main id="main" className="inspection-page desktop-inspection-page">
        <section className="desktop-inspection-heading">
          <div><h1>Identify &amp; inspect item</h1><p>Place the item in view, then enter the order number to begin.</p></div>
          {onBack ? <button type="button" className="desktop-back-button" onClick={onBack} disabled={busy}>‹ Back</button> : null}
        </section>

        <section className="desktop-inspection-layout" aria-label="Item inspection" aria-busy={busy}>
          <article className="desktop-camera-card">
            <header>
              <div><span>Camera</span><h2>Item view</h2></div>
              <strong className={`desktop-state-pill ${stage}`} role="status" aria-live="polite">{stage === 'scanning' ? 'Scanning' : stage === 'complete' ? 'Complete' : 'Ready'}</strong>
            </header>
            <div className={`desktop-camera-view${cameraImage && referenceImage ? ' comparison' : ''}`}>
              {cameraImage && referenceImage ? (
                <div className="desktop-camera-comparison">
                  <figure>
                    <a href={referenceImage} target="_blank" rel="noreferrer" aria-label="Open enrolled reference image">
                      <img src={referenceImage} alt="Enrolled product reference" />
                    </a>
                    <figcaption className="reference">Reference</figcaption>
                  </figure>
                  <figure>
                    <a href={cameraImage} target="_blank" rel="noreferrer" aria-label="Open captured item image">
                      <img src={cameraImage} alt="Captured returned item" />
                    </a>
                    <figcaption>Captured</figcaption>
                  </figure>
                </div>
              ) : cameraImage ? (
                <a href={cameraImage} target="_blank" rel="noreferrer" aria-label="Open captured item image">
                  <img src={cameraImage} alt="Captured returned item" />
                  <span>Captured item</span>
                </a>
              ) : <CameraEmptyState pending={busy} failed={failed} />}
            </div>
            <p>Keep the full item visible and remove other objects from the camera area.</p>
          </article>

          <aside className="desktop-scan-card">
            <header>
              <span>Inspection</span>
              <h2>{complete ? 'Inspection complete' : busy ? 'Analyzing item' : 'Ready to scan'}</h2>
              <p>{complete ? 'Review the results, then continue to the final decision.' : busy ? 'The capture is being compared with the product reference.' : 'Start with the order number so the correct reference is loaded.'}</p>
            </header>

            <section className={`desktop-order-summary${scan?.order ? ' loaded' : ''}`} aria-label="Order summary">
              <div className="desktop-order-heading"><span>Order details</span>{scan?.order && <strong>Loaded</strong>}</div>
              {scan?.order ? (
                <>
                  <h3>{scan.order.product_name}</h3>
                  <dl>
                    <div><dt>Order</dt><dd>{scan.order.order_number}</dd></div>
                    <div><dt>SKU</dt><dd>{scan.order.sku || '—'}</dd></div>
                    <div><dt>Expected</dt><dd>{formatWeight(scan.weight?.expected_weight_g ?? scan.order.expected_weight_g)}</dd></div>
                  </dl>
                </>
              ) : (
                <div className="desktop-order-empty"><span aria-hidden="true">#</span><p>No order selected yet.</p></div>
              )}
            </section>

            <button type="button" className="desktop-scan-button" disabled={busy} onClick={openOrderDialog}>
              <span aria-hidden="true">{complete ? '↻' : '⌁'}</span>
              {busy ? 'Scanning item…' : complete ? 'Scan again' : 'Scan item'}
            </button>
            <small>You’ll enter the order number before the scan begins.</small>
            <ScanProgress activeStage={stage} />
          </aside>

          <section className={`desktop-analysis-card ${stage}`} aria-labelledby="analysis-heading">
            <div className="desktop-analysis-heading">
              <span>Analysis results</span>
              <h2 id="analysis-heading">{complete ? decisionLabel(scan?.decision || visualDecision) : busy ? 'Analysis in progress' : 'Waiting to scan'}</h2>
              {complete && Number.isFinite(verification?.confidence_percent) && <strong>{verification.confidence_percent.toFixed(1)}% confidence</strong>}
            </div>
            <div className="desktop-analysis-checks">
              <div className={complete && scan?.weight ? (scan.weight.within_tolerance ? 'pass' : 'review') : ''}>
                <span aria-hidden="true">{complete && scan?.weight ? (scan.weight.within_tolerance ? '✓' : '!') : '—'}</span>
                <p><strong>Weight</strong><small>{complete && scan?.weight ? `${formatWeight(scan.weight.measured_weight_g)} · ${scan.weight.within_tolerance ? 'Within tolerance' : 'Outside tolerance'}` : 'Waiting for scan'}</small></p>
              </div>
              <div className={complete && visualDecision ? (visualDecision === 'consistent' ? 'pass' : 'review') : ''}>
                <span aria-hidden="true">{complete && visualDecision ? (visualDecision === 'consistent' ? '✓' : '!') : '—'}</span>
                <p><strong>Visual match</strong><small>{complete && visualDecision ? decisionLabel(visualDecision) : 'Waiting for scan'}</small></p>
              </div>
              <div className={complete && photoCount ? 'pass' : ''}>
                <span aria-hidden="true">{complete && photoCount ? '✓' : '—'}</span>
                <p><strong>Camera capture</strong><small>{complete && photoCount ? `${photoCount} view${photoCount === 1 ? '' : 's'} saved` : 'Waiting for scan'}</small></p>
              </div>
            </div>
            {(error || scan?.error) && <p className="scan-error desktop-inline-error" role="alert">{error || scan.error}</p>}
          </section>
        </section>
      </main>
      <footer className="inspection-footer desktop-inspection-footer">
        <div><strong>{complete ? 'Inspection complete' : 'Scan required before review'}</strong><span>{complete ? 'The final decision remains with the reviewer.' : 'Complete the camera scan to continue.'}</span></div>
        <div>
          {onBack ? <button type="button" className="desktop-footer-back" onClick={onBack} disabled={busy}>Back</button> : null}
          <button type="button" className="desktop-footer-continue" onClick={onContinue} disabled={busy || !complete}>Continue to review <span aria-hidden="true">›</span></button>
        </div>
      </footer>
      <dialog className="scan-order-dialog" ref={dialogRef} aria-labelledby="scan-order-title" onCancel={(event) => { event.preventDefault(); closeOrderDialog() }}>
        <div className="scan-order-heading">
          <div><span>Start inspection</span><h2 id="scan-order-title">Enter order number</h2><p>The scan starts automatically after the order is confirmed.</p></div>
          <button type="button" className="scan-order-close" aria-label="Close order entry" disabled={submitting} onClick={closeOrderDialog}>×</button>
        </div>
        <form onSubmit={startScan} className="scan-order-lookup">
          <label htmlFor="scan-order-number">Order number</label>
          <div className="scan-order-input-row">
            <input ref={orderInputRef} id="scan-order-number" name="order_number" value={orderNumber} onChange={(event) => changeOrderNumber(event.target.value)} placeholder="Enter order number" maxLength={64} disabled={submitting} required />
            <button type="submit" className="scan-order-submit" disabled={submitting || !orderNumber.trim()}>{lookingUp ? 'Loading order…' : submitting ? 'Starting scan…' : 'Start scan'}</button>
          </div>
          <div className="scan-order-keypad" role="group" aria-label="Order number keypad">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
              <button type="button" key={digit} disabled={submitting} onClick={() => enterKeypadDigit(digit)}>{digit}</button>
            ))}
            <button type="button" className="keypad-action" disabled={submitting || !orderNumber} onClick={() => changeOrderNumber('')}>Clear</button>
            <button type="button" disabled={submitting} onClick={() => enterKeypadDigit(0)}>0</button>
            <button type="button" className="keypad-action keypad-delete" aria-label="Delete last digit" disabled={submitting || !orderNumber} onClick={removeKeypadDigit}>⌫</button>
          </div>
          <p className="scan-order-help">Use an order with a product reference enrolled in the station database.</p>
        </form>
        {orderError && <p className="scan-error" role="alert">{orderError}</p>}
      </dialog>
    </>
  )
}

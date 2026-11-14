import { useEffect, useRef, useState } from 'react'
import ScanResults from './ScanResults.jsx'
import { scanRequest } from './scanApi.js'
import './ItemInspection.css'
import './OrderScan.css'

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
    setOrderNumber(value.replace(/\D/g, '').slice(0, 64))
  }

  function handleOrderKey(event) {
    if (submitting) return
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault()
      changeOrderNumber(orderNumber + event.key)
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      changeOrderNumber(event.key === 'Delete' ? '' : orderNumber.slice(0, -1))
    }
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
      const order = await scanRequest(`/v1/orders/${encodeURIComponent(number)}`, { signal: controller.signal })
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
      <main id="main" className="inspection-page">
        <nav className="scan-navigation" aria-label="Return workflow">
          <button type="button" className="save-button" onClick={onBack} disabled={busy}>Back to identification</button>
          <span>Identify return → Inspect item → Review decision</span>
        </nav>
        <section className="inspection-intro">
          <div><h1>Inspect the returned item</h1><p>Capture available station cameras and compare against enrolled product references.</p></div>
          <div><strong>{scan?.order ? `Order ${scan.order.order_number}` : 'No order selected'}</strong><p>{scan?.order?.product_name || 'Choose an order to load its reference and expected weight.'}</p></div>
        </section>
        <section className="scan-panel" aria-labelledby="scan-heading" aria-busy={busy}>
          <div className="scan-toolbar">
            <div><h2 id="scan-heading">Camera inspection</h2><p>Keep the item still with its surfaces clearly visible. Each camera view is inspected against the expected product references.</p></div>
            <button type="button" className="continue-button" disabled={busy} onClick={openOrderDialog}>
              {busy ? 'Scanning…' : scan?.results ? 'Scan again' : 'Scan item'}
            </button>
          </div>
          <p role="status" aria-live="polite">{submitting ? 'Requesting fresh camera captures…' : pending ? 'Capturing and comparing camera views. Results will appear automatically.' : scan?.status === 'complete' ? 'Scan finished. Review camera results below.' : 'Ready to scan.'}</p>
          {(error || scan?.error) && <p className="scan-error" role="alert">{error || scan.error}</p>}
          <ScanResults scan={scan} />
        </section>
      </main>
      <footer className="inspection-footer">
        <div><strong>Visual inspection</strong><span>Review marked differences before making a return decision.</span></div>
        <button type="button" className="continue-button" onClick={onContinue} disabled={busy || scan?.status !== 'complete'}>Continue to review</button>
      </footer>
      <dialog className="scan-order-dialog" ref={dialogRef} aria-labelledby="scan-order-title" onCancel={(event) => { event.preventDefault(); closeOrderDialog() }}>
        <div className="scan-order-heading">
          <div><h2 id="scan-order-title">Scan an order</h2><p>Enter the order number to load its reference and start scanning.</p></div>
          <button type="button" className="save-button" disabled={submitting} onClick={closeOrderDialog}>Close</button>
        </div>
        <form onSubmit={startScan} className="scan-order-lookup">
          <div className="scan-order-entry">
            <div className="scan-order-actions">
              <label htmlFor="scan-order-number">Order number</label>
              <input ref={orderInputRef} id="scan-order-number" name="order_number" value={orderNumber} readOnly inputMode="none" onKeyDown={handleOrderKey} placeholder="Enter order number" disabled={submitting} aria-describedby="scan-order-hint" />
              <p id="scan-order-hint" className="scan-order-help">Demo order: 1</p>
              <button type="submit" className="continue-button" disabled={submitting || !orderNumber.trim()}>{lookingUp ? 'Loading order…' : submitting ? 'Starting scan…' : 'Scan item'}</button>
            </div>
            <div className="scan-order-numpad" role="group" aria-label="Order number keypad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Clear', '0', '⌫'].map((key) => (
                <button key={key} type="button" disabled={submitting} aria-label={key === '⌫' ? 'Backspace' : key === 'Clear' ? 'Clear order number' : key} onClick={() => changeOrderNumber(key === 'Clear' ? '' : key === '⌫' ? orderNumber.slice(0, -1) : orderNumber + key)}>{key}</button>
              ))}
            </div>
          </div>
        </form>
        {orderError && <p className="scan-error" role="alert">{orderError}</p>}
      </dialog>
    </>
  )
}

import { useEffect, useState } from 'react'
import ScanResults from './ScanResults.jsx'
import { scanRequest } from './scanApi.js'
import './ItemInspection.css'

export default function ItemInspection({ returnCase, onBack, onContinue, scan, onScanChange }) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const scanId = scan?.scan_id
  const pending = scan?.status === 'queued' || scan?.status === 'processing'
  const busy = submitting || pending

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

  async function startScan() {
    setSubmitting(true)
    setError('')
    try {
      const next = await scanRequest('/v1/cameras/scan', { method: 'POST' })
      onScanChange(next)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
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
          <div><strong>{returnCase.id}</strong><p>{returnCase.productName}</p></div>
        </section>
        <section className="scan-panel" aria-labelledby="scan-heading" aria-busy={busy}>
          <div className="scan-toolbar">
            <div><h2 id="scan-heading">Camera inspection</h2><p>Keep the item still with its surfaces clearly visible. Each camera view is inspected against the expected product references.</p></div>
            <button type="button" className="continue-button" disabled={busy} onClick={startScan}>
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
        <button type="button" className="continue-button" onClick={onContinue} disabled={busy}>Continue to review</button>
      </footer>
    </>
  )
}

import { useEffect, useRef, useState } from 'react'
import CameraCapture from './CameraCapture.jsx'
import { artifactUrl, scanRequest } from './scanApi.js'
import useProducts from './useProducts.js'
import './ObjectPages.css'

const AUTO = '__auto__'

const flagLabels = {
  damage: 'Damage',
  different_item: 'Different item',
  missing_parts: 'Missing parts',
  counterfeit_evidence: 'Counterfeit evidence',
  insufficient_visual_evidence: 'Insufficient evidence',
}

const decisionCopy = {
  consistent: ['Match', 'The object is visually consistent with its enrolled references.', 'good'],
  suspicious: ['Review needed', 'Differences were found. Check the boxed areas below.', 'bad'],
  inconclusive: ['Inconclusive', 'The photo was not clear enough to decide. Try a sharper, closer shot.', 'warn'],
}

function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—'
}

export default function ScanObject({ initialProductId, embedded = false }) {
  const [productId, setProductId] = useState(initialProductId || AUTO)
  const [photo, setPhoto] = useState(null) // { file, url }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const requestRef = useRef(null)

  const { products, error: loadError, loaded } = useProducts()
  useEffect(() => () => requestRef.current?.abort(), [])
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url) }, [photo])

  const verify = async (file) => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setPhoto({ file, url: URL.createObjectURL(file) })
    setResult(null)
    setError('')
    setBusy(true)
    const form = new FormData()
    form.append('file', file, file.name || 'scan.jpg')
    if (productId !== AUTO) form.append('expected_product_id', productId)
    try {
      const body = await scanRequest('/v1/verify', { method: 'POST', body: form, signal: controller.signal, timeoutMs: 120000 })
      if (!controller.signal.aborted) setResult(body)
    } catch (err) {
      if (!controller.signal.aborted) setError(err.message)
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  const noProducts = loaded && !loadError && products.length === 0
  const [title, summary, tone] = result ? (decisionCopy[result.decision] || decisionCopy.inconclusive) : []
  const reference = artifactUrl(result?.annotated_reference_image_url || result?.reference_image_url)
  const captured = artifactUrl(result?.annotated_image_url || result?.original_image_url)
  const stage = busy ? 'scanning' : result ? 'complete' : 'ready'

  const content = (
    <>
      {!embedded ? <header className="obj-heading">
        <div>
          <span className="obj-eyebrow">Verification</span>
          <h1>Scan object</h1>
          <p>Capture the object with this device’s camera and compare it with its enrolled reference photos.</p>
        </div>
      </header> : null}

      <div className="obj-layout">
        <section className="obj-card" aria-labelledby="scan-camera-title">
          <header className="obj-card-header">
            <div><span>Camera</span><h2 id="scan-camera-title">Capture the object</h2></div>
            <strong className={`obj-pill ${stage}`} role="status">{busy ? 'Analyzing' : result ? 'Complete' : 'Ready'}</strong>
          </header>
          <CameraCapture
            onCapture={([file]) => verify(file)}
            disabled={busy || noProducts}
            captureLabel={busy ? 'Analyzing…' : 'Capture & scan'}
            hint="Place the object in the guide, matching an angle used during enrollment."
          />
        </section>

        <aside className="obj-card obj-side">
          <header className="obj-card-header">
            <div><span>Compare with</span><h2>Enrolled object</h2></div>
          </header>
          <label className="obj-field">
            <span>Object</span>
            <select value={productId} onChange={(event) => setProductId(event.target.value)} disabled={busy}>
              <option value={AUTO}>Auto-identify from catalog</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>{product.name} ({product.reference_count} ref{product.reference_count === 1 ? '' : 's'})</option>
              ))}
            </select>
            <small>Choosing the expected object is faster and more accurate than auto-identify.</small>
          </label>
          {noProducts ? <p className="obj-note">No products are enrolled yet. Add one in <strong>Product Catalog</strong> first.</p> : null}
          {loadError ? <p className="obj-error" role="alert">{loadError}</p> : null}

          {photo ? (
            <figure className="obj-last-capture">
              <img src={photo.url} alt="Last captured photo" />
              <figcaption>{busy ? 'Sending to the backend…' : 'Last capture'}</figcaption>
            </figure>
          ) : null}
          {busy ? <div className="obj-progress" aria-hidden="true"><i /></div> : null}
          {error ? <p className="obj-error" role="alert">{error}</p> : null}
          {result && photo && !busy ? (
            <button type="button" className="obj-btn wide" onClick={() => verify(photo.file)}>Re-run on same photo</button>
          ) : null}
        </aside>

        {result ? (
          <section className={`obj-card obj-result ${tone}`} aria-labelledby="scan-result-title">
            <header className="obj-result-header">
              <div>
                <span>Result · {result.compared_product?.name}</span>
                <h2 id="scan-result-title">{title}</h2>
                <p>{summary}</p>
              </div>
              <div className="obj-score">
                <strong>{Math.round(result.confidence_percent)}%</strong>
                <small>model confidence</small>
              </div>
            </header>

            {reference || captured ? (
              <div className="obj-compare">
                {reference ? (
                  <figure><a href={reference} target="_blank" rel="noreferrer"><img src={reference} alt="Enrolled reference" /></a><figcaption>Reference</figcaption></figure>
                ) : null}
                {captured ? (
                  <figure><a href={captured} target="_blank" rel="noreferrer"><img src={captured} alt="Captured object with discrepancy boxes" /></a><figcaption>Captured</figcaption></figure>
                ) : null}
              </div>
            ) : null}

            {result.flags ? (
              <ul className="obj-flags">
                {Object.entries(flagLabels).map(([key, label]) => {
                  const flag = result.flags[key]
                  if (!flag) return null
                  return (
                    <li key={key} className={flag.status} title={flag.evidence}>
                      <span aria-hidden="true">{flag.status === 'absent' ? '✓' : flag.status === 'present' ? '!' : '?'}</span>
                      <p><strong>{label}</strong><small>{flag.status === 'absent' ? 'Not found' : flag.status === 'present' ? 'Found' : 'Unknown'} · {percent(flag.confidence)}</small></p>
                    </li>
                  )
                })}
              </ul>
            ) : null}

            {result.discrepancies?.length ? (
              <ol className="obj-discrepancies">
                {result.discrepancies.map((item, index) => (
                  <li key={`${item.category}-${index}`}>
                    <strong>{index + 1}. {flagLabels[item.category] || item.category}</strong>
                    <span>{item.description}</span>
                    <small>{percent(item.confidence)}</small>
                  </li>
                ))}
              </ol>
            ) : null}

            {[...(result.reasons || []), ...(result.warnings || [])].length ? (
              <ul className="obj-reasons">
                {[...(result.reasons || []), ...(result.warnings || [])].map((line) => <li key={line}>{line}</li>)}
              </ul>
            ) : null}

            <p className="obj-muted">
              Confidence is the model’s own assessment, not a calibrated authenticity probability.
              {Number.isFinite(result.latency_ms?.total) ? ` Processed in ${(result.latency_ms.total / 1000).toFixed(1)} s.` : ''}
            </p>
          </section>
        ) : null}
      </div>
    </>
  )

  return embedded
    ? <section className="obj-workflow-stage" aria-label="Scan comparison item">{content}</section>
    : <main id="main" className="obj-page">{content}</main>
}

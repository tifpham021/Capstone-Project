import { useEffect, useMemo, useRef, useState } from 'react'
import CameraCapture from './CameraCapture.jsx'
import OnScreenKeyboard from './OnScreenKeyboard.jsx'
import { scanRequest } from './scanApi.js'
import useProducts from './useProducts.js'
import './ObjectPages.css'

const MAX_REFERENCES = 8
const NEW_OBJECT = '__new__'

function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

export default function EnrollObject({ onScanObject, embedded = false }) {
  const [target, setTarget] = useState(NEW_OBJECT)
  const [name, setName] = useState('')
  const [sku, setSku] = useState('')
  const [barcode, setBarcode] = useState('')
  const [expectedWeightKg, setExpectedWeightKg] = useState('')
  const [weightTolerancePercent, setWeightTolerancePercent] = useState('5')
  const [photos, setPhotos] = useState([]) // { file, url }
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [enrolled, setEnrolled] = useState(null)
  const [keyboardField, setKeyboardField] = useState(null)

  const { products, error: loadError, reload: loadProducts } = useProducts()
  // Object URLs are revoked when a photo is removed and when the page unmounts.
  const photosRef = useRef(photos)
  useEffect(() => { photosRef.current = photos }, [photos])
  useEffect(() => () => photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.url)), [])
  const clearPhotos = () => setPhotos((current) => {
    current.forEach((photo) => URL.revokeObjectURL(photo.url))
    return []
  })

  const existing = useMemo(() => products.find((p) => p.id === target), [products, target])
  const isNew = target === NEW_OBJECT
  const effectiveId = isNew ? slugify(name) : target
  const idValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(effectiveId)
  const expectedWeight = Number(expectedWeightKg)
  const weightTolerance = Number(weightTolerancePercent)
  const weightValid = Number.isFinite(expectedWeight) && expectedWeight > 0
  const toleranceValid = Number.isFinite(weightTolerance) && weightTolerance >= 0 && weightTolerance <= 100
  const full = photos.length >= MAX_REFERENCES
  const ready = photos.length > 0 && !saving && weightValid && toleranceValid && (
    isNew ? name.trim() && idValid : Boolean(existing)
  )

  const addPhotos = (files) => {
    setEnrolled(null)
    setError('')
    const room = MAX_REFERENCES - photos.length
    if (files.length > room) setError(`Only ${MAX_REFERENCES} reference photos can be enrolled; extra photos were skipped.`)
    const added = files.slice(0, Math.max(room, 0)).map((file) => ({ file, url: URL.createObjectURL(file) }))
    setPhotos((current) => [...current, ...added])
  }

  const removePhoto = (index) => setPhotos((current) => {
    URL.revokeObjectURL(current[index].url)
    return current.filter((_, i) => i !== index)
  })

  const adjustTolerance = (amount) => {
    const current = Number(weightTolerancePercent)
    const next = Math.min(100, Math.max(0, (Number.isFinite(current) ? current : 0) + amount))
    setWeightTolerancePercent(String(Math.round(next * 10) / 10))
  }

  const reset = () => {
    clearPhotos()
    setName('')
    setSku('')
    setBarcode('')
    setExpectedWeightKg('')
    setWeightTolerancePercent('5')
    setKeyboardField(null)
    setError('')
  }

  const keyboardFields = {
    name: { label: 'Product name', mode: 'text', value: name, setValue: setName, maxLength: 200 },
    expectedWeightKg: { label: 'Expected weight', mode: 'number', value: expectedWeightKg, setValue: setExpectedWeightKg },
    weightTolerancePercent: { label: 'Weight tolerance', mode: 'number', value: weightTolerancePercent, setValue: setWeightTolerancePercent },
    sku: { label: 'SKU', mode: 'text', value: sku, setValue: setSku, maxLength: 100 },
    barcode: { label: 'Barcode', mode: 'text', value: barcode, setValue: setBarcode, maxLength: 128 },
  }
  const activeKeyboard = keyboardField ? keyboardFields[keyboardField] : null

  const submit = async (event) => {
    event.preventDefault()
    if (!ready) return
    setSaving(true)
    setError('')
    const form = new FormData()
    photos.forEach((photo, index) => form.append('references', photo.file, photo.file.name || `reference-${index}.jpg`))
    try {
      let result
      if (isNew) {
        form.append('product_id', effectiveId)
        form.append('name', name.trim())
        if (sku.trim()) form.append('sku', sku.trim())
        if (barcode.trim()) form.append('barcode', barcode.trim())
        form.append('expected_weight_g', String(expectedWeight * 1000))
        form.append('weight_tolerance_percent', String(weightTolerance))
        result = await scanRequest('/v1/products', { method: 'POST', body: form, timeoutMs: 60000 })
      } else {
        form.append('expected_weight_g', String(expectedWeight * 1000))
        form.append('weight_tolerance_percent', String(weightTolerance))
        result = await scanRequest(`/v1/products/${encodeURIComponent(target)}/references`, { method: 'PUT', body: form, timeoutMs: 60000 })
      }
      setEnrolled({ ...result, replaced: !isNew })
      reset()
      setTarget(NEW_OBJECT)
      loadProducts()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const content = (
    <>
      {!embedded ? <header className="obj-heading">
        <div>
          <span className="obj-eyebrow">Reference library</span>
          <h1>Enroll object</h1>
          <p>Photograph a genuine object with this device’s camera. Scans are compared against these reference photos.</p>
        </div>
        <span className="obj-count"><strong>{products.length}</strong> enrolled</span>
      </header> : null}

      <div className="obj-layout">
        <section className={`obj-card obj-camera-card${activeKeyboard ? ' keyboard-open' : ''}`} aria-labelledby="enroll-camera-title">
          <header className="obj-card-header">
            <div><span>Camera</span><h2 id="enroll-camera-title">Capture reference photos</h2></div>
            <strong className={`obj-pill${photos.length ? ' good' : ''}`}>{photos.length} / {MAX_REFERENCES}</strong>
          </header>
          <CameraCapture
            multiple
            onCapture={addPhotos}
            disabled={full || saving}
            captureLabel={full ? 'Photo limit reached' : 'Capture reference'}
            hint="Use several angles: front, back, sides and any labels."
          />
          {activeKeyboard ? (
            <OnScreenKeyboard
              key={keyboardField}
              field={keyboardField}
              label={activeKeyboard.label}
              mode={activeKeyboard.mode}
              value={activeKeyboard.value}
              maxLength={activeKeyboard.maxLength}
              onChange={activeKeyboard.setValue}
              onClose={() => setKeyboardField(null)}
            />
          ) : null}
          {photos.length ? (
            <ul className="obj-thumbs" aria-label="Captured reference photos">
              {photos.map((photo, index) => (
                <li key={photo.url}>
                  <img src={photo.url} alt={`Reference ${index + 1}`} />
                  <span>{index + 1}</span>
                  <button type="button" aria-label={`Remove reference ${index + 1}`} onClick={() => removePhoto(index)} disabled={saving}>×</button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="obj-muted">No photos yet. Capture 3–6 views for the most reliable matches.</p>
          )}
        </section>

        <aside className="obj-card obj-side">
          <form onSubmit={submit} className="obj-form">
            <header className="obj-card-header">
              <div><span>Details</span><h2>{isNew ? 'New object' : 'Re-enroll object'}</h2></div>
            </header>

            <label className="obj-field">
              <span>Object</span>
              <select value={target} onChange={(event) => {
                const nextTarget = event.target.value
                const nextProduct = products.find((product) => product.id === nextTarget)
                setTarget(nextTarget)
                setExpectedWeightKg(Number.isFinite(nextProduct?.expected_weight_g) ? String(nextProduct.expected_weight_g / 1000) : '')
                setWeightTolerancePercent(Number.isFinite(nextProduct?.weight_tolerance_percent) ? String(nextProduct.weight_tolerance_percent) : '5')
                setKeyboardField(null)
                setEnrolled(null)
                setError('')
              }} disabled={saving}>
                <option value={NEW_OBJECT}>+ New object</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>{product.name} ({product.id})</option>
                ))}
              </select>
            </label>

            {isNew ? (
              <>
                <label className="obj-field">
                  <span>Name *</span>
                  <input value={name} onFocus={() => setKeyboardField('name')} onChange={(event) => setName(event.target.value)} placeholder="e.g. Black wireless mouse" maxLength={200} disabled={saving} required />
                </label>
                <div className="obj-field-row">
                  <label className="obj-field">
                    <span>Expected weight (kg) *</span>
                    <input type="number" inputMode="decimal" min="0.001" step="0.001" value={expectedWeightKg} onFocus={() => setKeyboardField('expectedWeightKg')} onChange={(event) => setExpectedWeightKg(event.target.value)} placeholder="e.g. 0.171" disabled={saving} required />
                  </label>
                  <div className="obj-field">
                    <span>Weight tolerance (%) *</span>
                    <div className="obj-touch-stepper">
                      <button type="button" onClick={() => adjustTolerance(-1)} disabled={saving || weightTolerance <= 0} aria-label="Decrease weight tolerance">−</button>
                      <input aria-label="Weight tolerance percentage" type="number" inputMode="decimal" min="0" max="100" step="0.1" value={weightTolerancePercent} onFocus={() => setKeyboardField('weightTolerancePercent')} onChange={(event) => setWeightTolerancePercent(event.target.value)} disabled={saving} required />
                      <button type="button" onClick={() => adjustTolerance(1)} disabled={saving || weightTolerance >= 100} aria-label="Increase weight tolerance">+</button>
                    </div>
                  </div>
                </div>
                <div className="obj-field-row">
                  <label className="obj-field">
                    <span>SKU</span>
                    <input value={sku} onFocus={() => setKeyboardField('sku')} onChange={(event) => setSku(event.target.value)} placeholder="Optional" maxLength={100} disabled={saving} />
                  </label>
                  <label className="obj-field">
                    <span>Barcode</span>
                    <input value={barcode} onFocus={() => setKeyboardField('barcode')} onChange={(event) => setBarcode(event.target.value)} placeholder="Optional" maxLength={128} disabled={saving} />
                  </label>
                </div>
              </>
            ) : existing ? (
              <>
                <div className="obj-note">
                  <strong>{existing.name}</strong>
                  <span>{existing.reference_count} reference photo{existing.reference_count === 1 ? '' : 's'}. Re-enrolling replaces the photos and updates the weight details.</span>
                </div>
                <div className="obj-field-row">
                  <label className="obj-field">
                    <span>Expected weight (kg) *</span>
                    <input type="number" inputMode="decimal" min="0.001" step="0.001" value={expectedWeightKg} onFocus={() => setKeyboardField('expectedWeightKg')} onChange={(event) => setExpectedWeightKg(event.target.value)} placeholder="e.g. 0.171" disabled={saving} required />
                  </label>
                  <div className="obj-field">
                    <span>Weight tolerance (%) *</span>
                    <div className="obj-touch-stepper">
                      <button type="button" onClick={() => adjustTolerance(-1)} disabled={saving || weightTolerance <= 0} aria-label="Decrease weight tolerance">−</button>
                      <input aria-label="Weight tolerance percentage" type="number" inputMode="decimal" min="0" max="100" step="0.1" value={weightTolerancePercent} onFocus={() => setKeyboardField('weightTolerancePercent')} onChange={(event) => setWeightTolerancePercent(event.target.value)} disabled={saving} required />
                      <button type="button" onClick={() => adjustTolerance(1)} disabled={saving || weightTolerance >= 100} aria-label="Increase weight tolerance">+</button>
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            <button type="submit" className="obj-btn primary wide" disabled={!ready}>
              {saving ? 'Enrolling…' : isNew ? `Enroll with ${photos.length || 'no'} photo${photos.length === 1 ? '' : 's'}` : 'Replace reference photos'}
            </button>
            {photos.length ? <button type="button" className="obj-btn wide" onClick={clearPhotos} disabled={saving}>Clear photos</button> : null}
            {error ? <p className="obj-error" role="alert">{error}</p> : null}
            {loadError ? <p className="obj-error" role="alert">{loadError}</p> : null}
            {enrolled ? (
              <div className="obj-success" role="status">
                <strong>{enrolled.replaced ? 'References replaced' : 'Object enrolled'}</strong>
                <span>{enrolled.name} · {enrolled.reference_count} reference photo{enrolled.reference_count === 1 ? '' : 's'}</span>
                {onScanObject ? <button type="button" className="obj-btn primary wide obj-continue" onClick={() => onScanObject(enrolled.id)}>Inspect this product →</button> : null}
              </div>
            ) : null}
          </form>
        </aside>
      </div>
    </>
  )

  return embedded
    ? <section className="obj-workflow-stage" aria-label="Enroll reference product">{content}</section>
    : <main id="main" className="obj-page">{content}</main>
}

import { useEffect, useMemo, useRef, useState } from 'react'
import CameraCapture from './CameraCapture.jsx'
import { scanRequest } from './scanApi.js'
import useProducts from './useProducts.js'
import './ObjectPages.css'

const MAX_REFERENCES = 8
const NEW_OBJECT = '__new__'

function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

export default function EnrollObject({ onScanObject }) {
  const [target, setTarget] = useState(NEW_OBJECT)
  const [name, setName] = useState('')
  const [productId, setProductId] = useState('')
  const [idEdited, setIdEdited] = useState(false)
  const [sku, setSku] = useState('')
  const [barcode, setBarcode] = useState('')
  const [photos, setPhotos] = useState([]) // { file, url }
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [enrolled, setEnrolled] = useState(null)

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
  const effectiveId = isNew ? (idEdited ? productId : slugify(name)) : target
  const idValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(effectiveId)
  const full = photos.length >= MAX_REFERENCES
  const ready = photos.length > 0 && !saving && (isNew ? name.trim() && idValid : Boolean(existing))

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

  const reset = () => {
    clearPhotos()
    setName('')
    setProductId('')
    setIdEdited(false)
    setSku('')
    setBarcode('')
    setError('')
  }

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
        result = await scanRequest('/v1/products', { method: 'POST', body: form, timeoutMs: 60000 })
      } else {
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

  return (
    <main id="main" className="obj-page">
      <header className="obj-heading">
        <div>
          <span className="obj-eyebrow">Reference library</span>
          <h1>Enroll object</h1>
          <p>Photograph a genuine object with this device’s camera. Scans are compared against these reference photos.</p>
        </div>
        <span className="obj-count"><strong>{products.length}</strong> enrolled</span>
      </header>

      <div className="obj-layout">
        <section className="obj-card" aria-labelledby="enroll-camera-title">
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
              <select value={target} onChange={(event) => { setTarget(event.target.value); setEnrolled(null); setError('') }} disabled={saving}>
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
                  <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Black wireless mouse" maxLength={200} disabled={saving} required />
                </label>
                <label className="obj-field">
                  <span>Object ID</span>
                  <input
                    value={effectiveId}
                    onChange={(event) => { setIdEdited(true); setProductId(event.target.value) }}
                    placeholder="auto-generated-from-name"
                    maxLength={64}
                    disabled={saving}
                    aria-invalid={Boolean(effectiveId) && !idValid}
                  />
                  <small className={effectiveId && !idValid ? 'bad' : ''}>Letters, digits, hyphens and underscores.</small>
                </label>
                <div className="obj-field-row">
                  <label className="obj-field">
                    <span>SKU</span>
                    <input value={sku} onChange={(event) => setSku(event.target.value)} placeholder="Optional" maxLength={100} disabled={saving} />
                  </label>
                  <label className="obj-field">
                    <span>Barcode</span>
                    <input value={barcode} onChange={(event) => setBarcode(event.target.value)} placeholder="Optional" maxLength={128} disabled={saving} />
                  </label>
                </div>
              </>
            ) : existing ? (
              <div className="obj-note">
                <strong>{existing.name}</strong>
                <span>Currently {existing.reference_count} reference photo{existing.reference_count === 1 ? '' : 's'}. Enrolling replaces all of them with the new set.</span>
              </div>
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
                {onScanObject ? <button type="button" className="obj-link" onClick={() => onScanObject(enrolled.id)}>Scan this object →</button> : null}
              </div>
            ) : null}
          </form>
        </aside>
      </div>
    </main>
  )
}

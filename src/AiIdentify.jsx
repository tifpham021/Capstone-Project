import { useEffect, useRef, useState } from 'react'
import TouchIcon from './TouchIcon.jsx'

export default function AiIdentify({ onBack, onDetected }) {
  const inputRef = useRef(null)
  const requestRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  useEffect(() => () => requestRef.current?.abort(), [])

  const identifyPhoto = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    setResult(null)
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPEG, PNG, or WebP photo of the item.')
      return
    }
    const controller = new AbortController()
    requestRef.current = controller
    setBusy(true)
    const timeout = window.setTimeout(() => controller.abort(), 120000)
    try {
      const form = new FormData()
      form.append('file', file)
      const base = (import.meta.env.VITE_AI_API_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '')
      const response = await fetch(`${base}/v1/verify`, { method: 'POST', body: form, signal: controller.signal })
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error('The AI service requires access. Contact your station administrator.')
        if (response.status === 413) throw new Error('That photo is too large. Choose a smaller image.')
        throw new Error('The AI service could not identify this item. Check that the product catalog has reference photos, then try again.')
      }
      const match = await response.json()
      if (!match.identified_product?.id || !match.identified_product?.name) throw new Error('No product match was returned. Try another photo.')
      setResult(match)
    } catch (failure) {
      setError(failure.name === 'AbortError' ? 'Identification timed out. Try again.' : failure instanceof TypeError ? 'Cannot reach the AI service. Check that the station’s AI backend is running.' : failure.message)
    } finally {
      window.clearTimeout(timeout)
      setBusy(false)
    }
  }

  return <section className="touch-card ai-identify" aria-label="AI identification">
    <TouchIcon name="sparkles" />
    <div className="ai-identify-copy"><h2>{result ? 'Confirm suggested item' : 'Identify with AI'}</h2>
      <p>{result ? result.identified_product.name : 'Choose a clear photo of the item. AI will look for a match in the product catalog.'}</p>
      {result && <small>{result.identity_ambiguous ? 'Several products look similar. Check the suggested item carefully.' : 'Check the suggested item before continuing.'}</small>}
      {error && <p className="touch-error" role="alert">{error}</p>}
      {busy && <p role="status">Identifying item…</p>}
    </div>
    <div className="ai-identify-actions">
      <button className="touch-secondary" onClick={onBack}>Back</button>
      {result && <button className="touch-primary" onClick={() => onDetected(result.identified_product.id, result.identified_product)}>Use this item</button>}
      <button className={result ? 'touch-secondary' : 'touch-primary'} disabled={busy} onClick={() => inputRef.current?.click()}><TouchIcon name="photo" />{result ? 'Try another photo' : 'Choose item photo'}</button>
    </div>
    <input ref={inputRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" onChange={identifyPhoto} aria-label="Choose item photo for AI" tabIndex={-1} />
  </section>
}

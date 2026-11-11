import { useEffect, useRef, useState } from 'react'
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
import {
  apiUrl,
  attachVerification,
  getReturn,
  recordWeight,
  uploadReturnImage,
  verifyPhoto,
} from './api.js'
import { evidenceSignals, latest } from './returnRecords.js'
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

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop())
}

const formatKg = (grams, signed = false) => {
  const kg = grams / 1000
  return `${signed && kg > 0 ? '+' : ''}${kg.toFixed(2)} kg`
}

function ItemInspection({ returnCase, onServerUpdate, onNoteChange, onBack, onContinue }) {
  const saved = Boolean(returnCase.saved)
  const [note, setNote] = useState(returnCase.inspectionNote || '')
  const [photoCount, setPhotoCount] = useState(2)
  const [weight, setWeight] = useState('1.61')
  const [weightInput, setWeightInput] = useState('')
  const [savingWeight, setSavingWeight] = useState(false)
  const [aiStatus, setAiStatus] = useState('')
  const [feedback, setFeedback] = useState('')
  const [photoMode, setPhotoMode] = useState(null)
  const [cameraError, setCameraError] = useState('')
  const [returnedPreview, setReturnedPreview] = useState(returnedItem)
  const [addedPhotos, setAddedPhotos] = useState([])
  const fileInputRef = useRef(null)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const addedPhotosRef = useRef([])

  function closePhotoTools() {
    setPhotoMode(null)
    setCameraError('')
  }

  useEffect(() => {
    addedPhotosRef.current = addedPhotos
  }, [addedPhotos])

  useEffect(() => {
    return () => {
      stopStream(streamRef.current)
      addedPhotosRef.current.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [])

  useEffect(() => {
    if (!photoMode) return undefined

    const onKeyDown = (event) => {
      if (event.key === 'Escape') closePhotoTools()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [photoMode])

  useEffect(() => {
    if (photoMode !== 'camera') return undefined

    let cancelled = false
    const videoElement = videoRef.current

    const startCamera = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('Camera is not supported in this browser. Upload a file instead.')
        return
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })

        if (cancelled) {
          stopStream(stream)
          return
        }

        streamRef.current = stream
        if (videoElement) {
          videoElement.srcObject = stream
          await videoElement.play()
        }
      } catch {
        if (!cancelled) {
          setCameraError('Camera access was denied or is unavailable. You can still upload a file.')
        }
      }
    }

    startCamera()

    return () => {
      cancelled = true
      stopStream(streamRef.current)
      streamRef.current = null
      if (videoElement) videoElement.srcObject = null
    }
  }, [photoMode])

  const attachPhoto = (file) => {
    if (!file || !file.type.startsWith('image/')) {
      setFeedback('Choose an image file to add to the evidence package.')
      return
    }

    const url = URL.createObjectURL(file)
    setAddedPhotos((photos) => [...photos, url])
    setReturnedPreview(url)
    setPhotoCount((count) => Math.min(count + 1, 4))
    closePhotoTools()

    if (!saved) {
      setFeedback(`${file.name || 'Photo'} added to the evidence package (demo, not saved).`)
      return
    }
    savePhoto(file)
  }

  // Saves the photo to this return, then compares it with the product's
  // reference photos when the product is enrolled for AI.
  const savePhoto = async (file) => {
    setFeedback('Saving photo…')
    try {
      await uploadReturnImage(returnCase.id, file, 'label')
      onServerUpdate(await getReturn(returnCase.id))
      setFeedback(`Photo saved to ${returnCase.id}.`)
    } catch (error) {
      setFeedback(`Photo not saved: ${error.message}`)
      return
    }

    if (!returnCase.productId) return
    setAiStatus('Running the AI visual comparison… The first run after the server starts can take a minute.')
    try {
      const result = await verifyPhoto(file, returnCase.productId)
      await attachVerification(returnCase.id, result.request_id)
      onServerUpdate(await getReturn(returnCase.id))
      setAiStatus('')
    } catch (error) {
      setAiStatus(
        error.status === 404 || error.status === 409
          ? 'AI comparison skipped: this product has no reference photos enrolled yet.'
          : `AI comparison unavailable: ${error.message}`,
      )
    }
  }

  const submitWeight = async (event) => {
    event.preventDefault()
    const kg = Number.parseFloat(weightInput)
    if (!Number.isFinite(kg) || kg <= 0) {
      setFeedback('Enter the scale reading in kilograms, for example 1.61.')
      return
    }
    setSavingWeight(true)
    try {
      const check = await recordWeight(returnCase.id, Math.round(kg * 1000 * 10) / 10)
      onServerUpdate(await getReturn(returnCase.id))
      setWeightInput('')
      setFeedback(
        check.within_tolerance
          ? `Weight saved: ${formatKg(check.measured_weight_g)} is within tolerance.`
          : `Weight saved: ${formatKg(check.measured_weight_g)} is outside tolerance (${formatKg(check.difference_g, true)}).`,
      )
    } catch (error) {
      setFeedback(`Weight not saved: ${error.message}`)
    } finally {
      setSavingWeight(false)
    }
  }

  const updateNote = (value) => {
    setNote(value)
    onNoteChange?.(value)
  }

  const handleContinue = async () => {
    const error = await onContinue()
    if (error) setFeedback(error)
  }

  const onFileSelected = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    attachPhoto(file)
  }

  const capturePhoto = () => {
    const video = videoRef.current
    if (!video || !video.videoWidth) {
      setFeedback('Wait for the camera preview, then capture.')
      return
    }

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    canvas.toBlob((blob) => {
      if (!blob) {
        setFeedback('Could not capture that frame. Try again or upload a file.')
        return
      }
      attachPhoto(new File([blob], `serial-plate-${Date.now()}.jpg`, { type: 'image/jpeg' }))
    }, 'image/jpeg', 0.92)
  }

  const toggleTare = () => {
    const tared = weight === '0.00'
    setWeight(tared ? '1.61' : '0.00')
    setFeedback(tared ? 'Live scale reading restored.' : 'Scale tared successfully.')
  }

  // Saved returns show real evidence from the server; the demo keeps its sample data.
  const checkRows = saved ? evidenceSignals(returnCase) : checks
  const completedChecks = checkRows.filter((check) => check.state !== 'pending').length
  const attentionChecks = checkRows.filter((check) => check.state !== 'match').length
  const lastWeight = saved ? latest(returnCase.weightChecks) : null
  const referenceImage = saved ? apiUrl(returnCase.orderImages[0]?.url) : shippedReference
  const returnedImage = addedPhotos.length || !saved
    ? returnedPreview
    : apiUrl(latest(returnCase.returnImages)?.url)
  const imageCount = saved
    ? returnCase.orderImages.length + returnCase.returnImages.length
    : photoCount

  return (
    <>
      <main id="main" className="inspection-page">
        <InspectionWorkflow onBack={onBack} onContinue={handleContinue} />

        <section className="inspection-intro" aria-labelledby="inspection-title">
          <div>
            <h1 id="inspection-title">Inspect the returned item</h1>
            <p>Compare the live return against the verified shipment before making a decision.</p>
          </div>
          <div className="inspection-case">
            <div>
              <span>Return case</span>
              <strong>{returnCase.id}</strong>
              <small>{returnCase.productName} / {returnCase.productModel}</small>
            </div>
            <span className="needs-review"><i />Inspection in progress</span>
          </div>
        </section>

        <div className={`inspection-dashboard${saved ? ' saved-evidence' : ''}`}>
          <section className="comparison-card" aria-labelledby="comparison-title">
            <div className="comparison-heading">
              <h2 id="comparison-title">Visual comparison</h2>
              <span>{imageCount} images {saved ? 'saved' : 'synced'}</span>
            </div>

            <div className="comparison-images">
              <figure>
                {referenceImage ? (
                  <img src={referenceImage} alt={`Original photo of ${returnCase.productName} before shipping`} />
                ) : (
                  <p className="comparison-empty">No original photo on file for this order item.</p>
                )}
                <figcaption className="image-label reference-label"><i />Shipped reference</figcaption>
                {saved ? (
                  returnCase.orderImages.length ? <span className="image-count">01 / {String(returnCase.orderImages.length).padStart(2, '0')}</span> : null
                ) : <span className="image-count">01 / 04</span>}
              </figure>
              <figure>
                {returnedImage ? (
                  <img src={returnedImage} alt={`Photo of the returned ${returnCase.productName}`} />
                ) : (
                  <p className="comparison-empty">No photo yet. Use Add photo to capture the returned item.</p>
                )}
                <figcaption className="image-label returned-label"><i />Returned item</figcaption>
                <span className="image-count live-count">{addedPhotos.length || (saved && returnCase.returnImages.length) ? 'Added' : 'Live'}</span>
              </figure>
            </div>

            <div className="attention-panel">
              <StackedAsset className="attention-icon">
                <img src={warningCircle} alt="" />
                <img src={warningMark} alt="" />
              </StackedAsset>
              <div>
                {saved ? (
                  <>
                    <strong>{returnCase.returnImages.length ? 'Add another angle' : 'Photograph the returned item'}</strong>
                    <p>Capture the item and its serial plate. Photos are saved to this return and compared with the original.</p>
                  </>
                ) : (
                  <>
                    <strong>Photo angle needs attention</strong>
                    <p>Product shape appears consistent. Add a clear serial-plate photo to complete the check.</p>
                  </>
                )}
              </div>
              <button
                className="add-photo-button"
                type="button"
                onClick={() => setPhotoMode('choose')}
              >
                <span>＋</span>Add photo
              </button>
            </div>

            <label className="inspection-note">
              <span>Inspection note</span>
              <textarea
                value={note}
                onChange={(event) => updateNote(event.target.value)}
                placeholder="Add observations about packaging, wear, serial markings, or unusual details..."
              />
              <small>Notes will be included in the final review record.</small>
            </label>
          </section>

          <aside className="inspection-sidebar" aria-label="Automated inspection results">
            {saved ? (
            <section className="weight-card">
              <div className="weight-heading">
                <h2>Weight check</h2>
                <span className="stable-pill"><i />Manual entry</span>
              </div>
              <div className="weight-reading">
                <div className="current-weight">
                  <strong>{lastWeight ? (lastWeight.measured_weight_g / 1000).toFixed(2) : '—'}</strong><b>kg</b>
                  <span>{lastWeight ? 'Recorded scale reading' : 'No reading recorded yet'}</span>
                </div>
                <div className="expected-weight">
                  <span>Expected</span>
                  <strong>{returnCase.expectedWeightKg ? `${returnCase.expectedWeightKg.toFixed(2)} kg` : 'Not on file'}</strong>
                  {lastWeight ? (
                    <span>Delta <b className={lastWeight.within_tolerance ? '' : 'out'}>{formatKg(lastWeight.difference_g, true)}</b></span>
                  ) : null}
                </div>
              </div>
              <form className="weight-entry" onSubmit={submitWeight}>
                <label>
                  <span className="sr-only">Scale reading in kilograms</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.001"
                    min="0"
                    placeholder={returnCase.expectedWeightKg ? 'Scale reading in kg, e.g. 1.61' : 'No expected weight on file'}
                    value={weightInput}
                    onChange={(event) => setWeightInput(event.target.value)}
                    disabled={!returnCase.expectedWeightKg || savingWeight}
                  />
                </label>
                <button type="submit" disabled={!returnCase.expectedWeightKg || savingWeight || !weightInput}>
                  {savingWeight ? 'Saving…' : 'Record weight'}
                </button>
              </form>
              {lastWeight ? (
                <div className={`tolerance-bar${lastWeight.within_tolerance ? '' : ' out'}`}>
                  <span>{lastWeight.within_tolerance ? '✓' : '!'}</span>
                  <strong>
                    {lastWeight.within_tolerance ? 'Within' : 'Outside'} ±{(lastWeight.tolerance_g / 1000).toFixed(3)} kg tolerance
                  </strong>
                </div>
              ) : null}
            </section>
            ) : (
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
            )}

            <section className="automated-card">
              <div className="automated-heading">
                <h2>Automated checks</h2>
                <span>{completedChecks} of {checkRows.length} complete</span>
              </div>
              {aiStatus ? <p className="ai-status" role="status">{aiStatus}</p> : null}
              <div className="checks-list">
                {checkRows.map((check) => (
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
                <p>
                  {saved
                    ? 'Photos and weights are saved to this return as you add them. The note is saved with the decision.'
                    : 'Images, readings, and reviewer notes will carry into the decision.'}
                </p>
              </div>
              <span className="autosaved-pill">{saved ? 'Auto-saved' : 'Demo only'}</span>
            </section>
          </aside>
        </div>
      </main>

      <footer className="inspection-footer">
        <div>
          <strong>
            {attentionChecks ? `${attentionChecks} check${attentionChecks === 1 ? ' needs' : 's need'} attention` : 'All checks complete'}
          </strong>
          <span aria-live="polite">
            {feedback || (returnCase.demo
              ? 'Demo return: nothing on this page is saved. Start the backend and look up an order to save evidence.'
              : 'You can continue now or add the recommended photos for higher confidence.')}
          </span>
        </div>
        <div className="inspection-actions">
          <button
            type="button"
            className="save-button"
            onClick={() => setFeedback(saved
              ? `Photos and weights are already saved to ${returnCase.id}.`
              : 'Progress is kept for this browser session.')}
          >
            Save for later
          </button>
          <button type="button" className="continue-button" onClick={handleContinue}>
            Continue to review
            <img src={continueArrow} alt="" />
          </button>
        </div>
      </footer>

      {photoMode ? (
        <div
          className="camera-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="camera-title"
          onClick={(event) => {
            if (event.target === event.currentTarget) closePhotoTools()
          }}
        >
          <div className="camera-sheet">
            <div className="camera-sheet-header">
              <div>
                <h2 id="camera-title">
                  {photoMode === 'camera' ? 'Capture serial-plate photo' : 'Add inspection photo'}
                </h2>
                <p>
                  {photoMode === 'camera'
                    ? 'Hold the camera steady so the markings are readable.'
                    : 'Take a live photo or upload an image of the serial plate.'}
                </p>
              </div>
              <button type="button" className="camera-close" onClick={closePhotoTools}>Close</button>
            </div>
            {photoMode === 'choose' ? (
              <div className="photo-source-actions">
                <button type="button" className="continue-button" onClick={() => setPhotoMode('camera')}>
                  Take photo
                </button>
                <button type="button" className="save-button" onClick={() => fileInputRef.current?.click()}>
                  Upload file
                </button>
              </div>
            ) : (
              <>
                <div className="camera-preview">
                  {cameraError ? (
                    <p className="camera-error">{cameraError}</p>
                  ) : (
                    <video ref={videoRef} autoPlay playsInline muted />
                  )}
                </div>
                <div className="camera-sheet-actions">
                  <button type="button" className="save-button" onClick={() => fileInputRef.current?.click()}>
                    Upload file instead
                  </button>
                  <button
                    type="button"
                    className="continue-button"
                    onClick={capturePhoto}
                    disabled={Boolean(cameraError)}
                  >
                    Capture photo
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept="image/*"
        onChange={onFileSelected}
      />
    </>
  )
}

export default ItemInspection

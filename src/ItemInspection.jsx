import { useEffect, useRef, useState } from 'react'
import shippedReference from './assets/figma/inspection/4036d.png'
import returnedItem from './assets/figma/inspection/97c93.png'
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
import { RETURN_STATUS } from './returnLifecycle.js'
import './ItemInspection.css'
import './ReviewDecision.css'

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

const decisions = [
  {
    id: 'approve',
    title: 'Approve return',
    description: 'Issue the refund and close the case.',
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
    title: 'Flag suspected fraud',
    description: 'Hold the refund and send the case to investigation.',
    badge: 'Hold',
  },
]

function StackedAsset({ className = '', children }) {
  return <span className={`inspection-asset ${className}`}>{children}</span>
}

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop())
}

const formatKg = (grams, signed = false) => {
  const kg = grams / 1000
  return `${signed && kg > 0 ? '+' : ''}${kg.toFixed(2)} kg`
}

function ItemInspection({ returnCase, onServerUpdate, onBack, onSubmitDecision, reviewerName }) {
  const saved = Boolean(returnCase.saved)
  const [photoCount, setPhotoCount] = useState(2)
  const [weight, setWeight] = useState('1.61')
  const [weightInput, setWeightInput] = useState('')
  const [savingWeight, setSavingWeight] = useState(false)
  const [savingPhoto, setSavingPhoto] = useState(false)
  const [aiStatus, setAiStatus] = useState('')
  const [aiRunning, setAiRunning] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [photoMode, setPhotoMode] = useState(null)
  const [cameraError, setCameraError] = useState('')
  const [returnedPreview, setReturnedPreview] = useState(returnedItem)
  const [addedPhotos, setAddedPhotos] = useState([])
  const [decision, setDecision] = useState(returnCase.decision?.type || 'secondary')
  const [reason, setReason] = useState(returnCase.decision?.reason || 'Missing serial / identity evidence')
  const [decisionNote, setDecisionNote] = useState(returnCase.decision?.note || '')
  const [submitting, setSubmitting] = useState(false)
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
    setSavingPhoto(true)
    setFeedback('Saving photo…')
    try {
      await uploadReturnImage(returnCase.id, file, 'label')
      onServerUpdate(await getReturn(returnCase.id))
      setFeedback(`Photo saved to ${returnCase.id}.`)
    } catch (error) {
      setFeedback(`Photo not saved: ${error.message}`)
      setSavingPhoto(false)
      return
    }

    if (!returnCase.productId) {
      setSavingPhoto(false)
      return
    }
    setAiStatus('Running the AI visual comparison… The first run after the server starts can take a minute.')
    setAiRunning(true)
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
    } finally {
      setAiRunning(false)
      setSavingPhoto(false)
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
    if (!saved) {
      setWeight(kg.toFixed(2))
      setWeightInput('')
      setFeedback(`Weight entered manually: ${kg.toFixed(2)} kg (demo, not saved).`)
      setSavingWeight(false)
      return
    }
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

  // Saved returns show real evidence from the server; the demo keeps its sample data.
  const checkRows = saved ? evidenceSignals(returnCase) : checks
  const lastWeight = saved ? latest(returnCase.weightChecks) : null
  const referenceImage = saved ? apiUrl(returnCase.orderImages[0]?.url) : shippedReference
  const returnedImage = addedPhotos.length || !saved
    ? returnedPreview
    : apiUrl(latest(returnCase.returnImages)?.url)
  const imageCount = saved
    ? returnCase.orderImages.length + returnCase.returnImages.length
    : photoCount
  const isComplete = returnCase.status === RETURN_STATUS.COMPLETED
  const expectedWeight = saved ? returnCase.expectedWeightKg : 1.62
  const measuredWeight = saved
    ? (lastWeight ? lastWeight.measured_weight_g / 1000 : null)
    : Number.parseFloat(weight)
  const hasPhotoEvidence = saved
    ? Boolean(returnCase.returnImages.length)
    : Boolean(returnedImage)
  const hasWeightEvidence = Number.isFinite(measuredWeight) && measuredWeight > 0
  const analysisComplete = hasPhotoEvidence && hasWeightEvidence && !savingPhoto && !aiRunning
  const verification = saved ? latest(returnCase.verifications) : null
  const confidence = saved
    ? (verification && verification.decision !== 'inconclusive'
      ? Math.round(verification.confidence * 100)
      : null)
    : 91
  const refund = returnCase.refundAmount
  const weightDifference = measuredWeight !== null && expectedWeight
    ? measuredWeight - expectedWeight
    : null

  const describeDecision = (option) => (
    option.id === 'approve' && refund !== null && refund !== undefined
      ? `Issue the $${refund.toFixed(2)} refund and close the case.`
      : option.description
  )

  const submitDecision = async (event) => {
    event.preventDefault()
    if (submitting || isComplete) return
    if (!analysisComplete) {
      setFeedback('Add a return photo and measured weight, then wait for the analysis to finish.')
      return
    }
    if (decision !== 'approve' && !decisionNote.trim()) {
      setFeedback('Add a decision note explaining what the next reviewer should verify.')
      return
    }

    const title = decisions.find((option) => option.id === decision)?.title
    setSubmitting(true)
    setFeedback(saved ? 'Saving the final decision…' : '')
    const error = await onSubmitDecision({
      type: decision,
      title,
      reason: decision === 'approve' ? '' : reason,
      note: decisionNote,
    })
    setSubmitting(false)
    setFeedback(error || `${title} recorded for ${returnCase.id}.`)
  }

  return (
    <>
      <main id="main" className="inspection-page combined-page">
        <section className="inspection-intro combined-intro" aria-labelledby="inspection-title">
          <div>
            <h1 id="inspection-title">Inspect &amp; decide</h1>
            <p>Upload the return photos and enter the measured weight, then review the analysis before recording your decision.</p>
          </div>
          <div className="inspection-case">
            <div>
              <span>Return case</span>
              <strong>{returnCase.id}</strong>
              <small>{returnCase.productName} / {returnCase.productModel}</small>
            </div>
            <span className={`needs-review${isComplete ? ' completed' : ''}`}>
              <i />{isComplete ? 'Completed' : 'Needs review'}
            </span>
          </div>
        </section>

        <div className="combined-dashboard">
          <section className="combined-evidence-card" aria-labelledby="comparison-title">
            <div className="combined-card-heading">
              <div>
                <h2 id="comparison-title">Item evidence</h2>
                <p>Reference and returned-item photos</p>
              </div>
              <span>Manual inputs</span>
            </div>

            <div className="comparison-images combined-images">
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
                <span className="image-count live-count">
                  {!saved || addedPhotos.length || returnCase.returnImages.length ? 'Uploaded' : 'Needed'}
                </span>
              </figure>
            </div>

            <div className="combined-photo-tools">
              <div>
                <strong>✓ {imageCount} photo{imageCount === 1 ? '' : 's'} available</strong>
                <span>{saved ? 'Photos are saved to this return.' : 'Use the camera or upload files while hardware is disconnected.'}</span>
              </div>
              <div>
                <button type="button" onClick={() => setPhotoMode('choose')}>Replace photo</button>
                <button type="button" onClick={() => setPhotoMode('choose')}>Add angle</button>
              </div>
            </div>

            <section className="combined-weight-card" aria-labelledby="weight-title">
              <div className="combined-weight-heading">
                <div>
                  <h3 id="weight-title">Weight</h3>
                  <span>Entered manually</span>
                </div>
                <dl>
                  <div><dt>Expected</dt><dd>{expectedWeight ? `${expectedWeight.toFixed(2)} kg` : 'Not on file'}</dd></div>
                  <div><dt>Measured</dt><dd>{measuredWeight ? `${measuredWeight.toFixed(2)} kg` : '—'}</dd></div>
                  <div><dt>Delta</dt><dd>{weightDifference === null ? '—' : `${weightDifference >= 0 ? '+' : ''}${weightDifference.toFixed(2)} kg`}</dd></div>
                </dl>
              </div>
              <form className="combined-weight-entry" onSubmit={submitWeight}>
                <label>
                  <span className="sr-only">Scale reading in kilograms</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.001"
                    min="0"
                    placeholder={expectedWeight ? 'Enter measured weight in kg' : 'No expected weight on file'}
                    value={weightInput}
                    onChange={(event) => setWeightInput(event.target.value)}
                    disabled={!expectedWeight || savingWeight || isComplete}
                  />
                </label>
                <button type="submit" disabled={!expectedWeight || savingWeight || !weightInput || isComplete}>
                  {savingWeight ? 'Saving…' : 'Use this weight'}
                </button>
              </form>
            </section>

            {aiStatus ? <p className="ai-status combined-ai-status" role="status">{aiStatus}</p> : null}

            <section className={`combined-analysis${analysisComplete ? ' complete' : ''}`} aria-live="polite">
              <StackedAsset className="combined-analysis-icon">
                <img src={shieldCircle} alt="" />
                <img src={shieldCheck} alt="" />
              </StackedAsset>
              <div>
                <span>{analysisComplete ? 'Analysis complete' : 'Waiting for evidence'}</span>
                <h3>{analysisComplete ? 'Likely the same product' : 'Add a photo and measured weight'}</h3>
                <p>{analysisComplete ? 'Photos and weight are consistent. The final decision still requires a reviewer.' : 'Decision controls will unlock after both evidence inputs are available.'}</p>
                <div className="combined-signal-list">
                  {checkRows.map((check) => (
                    <b className={check.state} key={check.key || check.title}>
                      {check.state === 'match' ? '✓' : check.state === 'review' ? '!' : '·'} {check.title}
                    </b>
                  ))}
                </div>
              </div>
              <div className="combined-confidence">
                <strong>{analysisComplete && confidence !== null ? `${confidence}%` : '—'}</strong>
                <span>Match confidence</span>
              </div>
            </section>
          </section>

          <form id="combined-decision-form" className="decision-card combined-decision-card" onSubmit={submitDecision}>
            <div className="combined-decision-heading">
              <div><h2>Final decision</h2><p>The reviewer makes the final call. AI results are advisory.</p></div>
              <span className={analysisComplete ? 'ready' : ''}>{analysisComplete ? 'Analysis complete' : 'Waiting for analysis'}</span>
            </div>

            <div className="advisory-note">
              <span>i</span>
              <div>
                <strong>{analysisComplete ? 'Decision controls are ready.' : 'Decision controls unlock after analysis.'}</strong>
                <small>{analysisComplete ? 'Review the evidence and choose an outcome.' : 'Add the required photo and weight first.'}</small>
              </div>
            </div>

            <fieldset disabled={!analysisComplete || isComplete}>
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
                  <span><strong>{option.title}</strong><small>{describeDecision(option)}</small></span>
                  <b>{decision === option.id && option.id === 'secondary' ? 'Selected' : option.badge}</b>
                </label>
              ))}
            </fieldset>

            {decision !== 'approve' ? (
              <label className="decision-field">
                <span>Reason for escalation</span>
                <select value={reason} onChange={(event) => setReason(event.target.value)} disabled={!analysisComplete || isComplete}>
                  <option>Missing serial / identity evidence</option>
                  <option>Visual evidence is inconclusive</option>
                  <option>Weight measurement is inconsistent</option>
                  <option>Suspected item substitution</option>
                </select>
              </label>
            ) : null}

            <label className="decision-field decision-note">
              <span>Decision note</span>
              <textarea
                value={decisionNote}
                onChange={(event) => setDecisionNote(event.target.value)}
                placeholder="Explain what the next reviewer should verify..."
                disabled={!analysisComplete || isComplete}
              />
              <small>{decision === 'approve' ? 'Optional for approvals' : 'Required for escalations and fraud flags'}</small>
            </label>

            <span className="audit-note">Reviewer: {reviewerName} / Every decision is recorded in the audit log.</span>
          </form>
        </div>
      </main>

      <footer className="inspection-footer">
        <div>
          <strong>{isComplete ? 'Decision recorded' : analysisComplete ? 'Analysis complete — reviewer decision required' : 'Evidence required before a decision'}</strong>
          <span aria-live="polite">
            {feedback || (analysisComplete
              ? 'Review the AI result, choose an outcome, and add a note when escalation is needed.'
              : 'Upload the returned-item photo and enter the measured weight to continue.')}
          </span>
        </div>
        <div className="inspection-actions">
          <button type="button" className="back-button" onClick={onBack}>‹&nbsp; Back</button>
          <button
            type="button"
            className="save-button"
            onClick={() => setFeedback(saved
              ? `Photos and weights are already saved to ${returnCase.id}.`
              : 'Progress is kept for this browser session.')}
          >
            Save for later
          </button>
          <button
            type="submit"
            form="combined-decision-form"
            className="submit-review-button"
            disabled={!analysisComplete || isComplete || submitting}
          >
            {isComplete ? 'Decision recorded' : submitting ? 'Saving…' : 'Submit decision'}
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

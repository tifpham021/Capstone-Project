import { useCallback, useEffect, useRef, useState } from 'react'

// Live preview from the device's own camera (laptop webcam, USB webcam or
// phone camera) via getUserMedia. Captures full-resolution JPEG frames.
// Browsers only allow the camera on https:// or http://localhost.

function cameraErrorMessage(error) {
  if (!window.isSecureContext) return 'The camera needs https:// or http://localhost. Open the app that way, or upload a photo instead.'
  if (error?.name === 'NotAllowedError') return 'Camera access was blocked. Allow the camera in your browser settings, or upload a photo.'
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return 'No camera was found. Connect one, or upload a photo instead.'
  if (error?.name === 'NotReadableError') return 'The camera is in use by another app. Close it and try again.'
  return 'The camera could not be started. Upload a photo instead.'
}

function frameToBlob(video) {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Capture failed'))), 'image/jpeg', 0.92)
  })
}

export default function CameraCapture({
  onCapture,
  captureLabel = 'Capture photo',
  disabled = false,
  multiple = false,
  hint = 'Keep the whole object inside the guide on a plain background.',
}) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const fileRef = useRef(null)
  const [state, setState] = useState('idle') // idle | starting | live | error
  const [message, setMessage] = useState('')
  const [devices, setDevices] = useState([])
  const [deviceId, setDeviceId] = useState('')
  const [flash, setFlash] = useState(false)

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const start = useCallback(async (id = deviceId) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error')
      setMessage(cameraErrorMessage())
      return
    }
    stop()
    setState('starting')
    setMessage('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(id ? { deviceId: { exact: id } } : { facingMode: { ideal: 'environment' } }),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => {})
      }
      const activeId = stream.getVideoTracks()[0]?.getSettings().deviceId || id
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
      setDevices(list)
      setDeviceId(activeId || '')
      setState('live')
    } catch (error) {
      setState('error')
      setMessage(cameraErrorMessage(error))
    }
  }, [deviceId, stop])

  useEffect(() => stop, [stop])

  const capture = async () => {
    const video = videoRef.current
    if (!video?.videoWidth || disabled) return
    try {
      const blob = await frameToBlob(video)
      setFlash(true)
      window.setTimeout(() => setFlash(false), 180)
      onCapture([new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' })])
    } catch {
      setMessage('That frame could not be captured. Try again.')
    }
  }

  const upload = (event) => {
    const files = [...(event.target.files || [])].filter((file) => /^image\/(jpeg|png|webp)$/.test(file.type))
    event.target.value = ''
    if (files.length) onCapture(multiple ? files : files.slice(0, 1))
    else setMessage('Choose a JPEG, PNG or WebP photo.')
  }

  const live = state === 'live'

  return (
    <div className="camcap">
      <div className={`camcap-view${live ? ' live' : ''}${flash ? ' flash' : ''}`}>
        <video ref={videoRef} autoPlay playsInline muted aria-label="Live camera preview" hidden={!live} />
        {live ? (
          <span className="camcap-guide" aria-hidden="true" />
        ) : (
          <div className="camcap-empty">
            <span className="camcap-icon" aria-hidden="true" />
            <strong>{state === 'starting' ? 'Starting camera…' : state === 'error' ? 'Camera unavailable' : 'Camera is off'}</strong>
            <p role={state === 'error' ? 'alert' : undefined}>{state === 'error' ? message : hint}</p>
          </div>
        )}
        {live ? <span className="camcap-live-pill"><i />Live</span> : null}
      </div>

      <div className="camcap-controls">
        {live ? (
          <>
            <button type="button" className="obj-btn primary" onClick={capture} disabled={disabled}>
              <span aria-hidden="true">◉</span>{captureLabel}
            </button>
            <button type="button" className="obj-btn" onClick={() => { stop(); setState('idle') }}>Stop camera</button>
          </>
        ) : (
          <button type="button" className="obj-btn primary" onClick={() => start()} disabled={state === 'starting'}>
            {state === 'error' ? 'Try camera again' : 'Start camera'}
          </button>
        )}
        <button type="button" className="obj-btn" onClick={() => fileRef.current?.click()} disabled={disabled}>
          Upload photo{multiple ? 's' : ''}
        </button>
        {live && devices.length > 1 ? (
          <label className="camcap-device">
            <span className="sr-only">Camera</span>
            <select value={deviceId} onChange={(event) => { setDeviceId(event.target.value); start(event.target.value) }}>
              {devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {live && message ? <p className="obj-error" role="alert">{message}</p> : null}
      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple={multiple}
        onChange={upload}
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  )
}

import TouchIcon from './TouchIcon.jsx'
import AiIdentify from './AiIdentify.jsx'
import { useEffect, useRef, useState } from 'react'
import barcodeScanner from './assets/figma/c6ae5.svg'
import preview from './assets/station-preview.png'

// Reads barcodes and QR codes from the station camera or from a photo.
// ZXing is loaded on first use so it does not slow down the first page load.
let readerPromise = null

function loadReader() {
  if (!readerPromise) {
    readerPromise = import('@zxing/browser').then(({ BrowserMultiFormatReader }) => (
      new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 150 })
    ))
  }
  return readerPromise
}

function formatName(format) {
  // ZXing formats are numeric enum values; map the common ones to readable names.
  const names = {
    0: 'Aztec', 1: 'Codabar', 2: 'Code 39', 3: 'Code 93', 4: 'Code 128', 5: 'Data Matrix',
    6: 'EAN-8', 7: 'EAN-13', 8: 'ITF', 10: 'PDF417', 11: 'QR code', 14: 'UPC-A', 15: 'UPC-E',
  }
  return names[format] || 'Barcode'
}

function cameraErrorMessage(error) {
  if (error?.name === 'NotAllowedError') return 'Camera access was blocked. Allow the camera in your browser, or scan from a photo.'
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return 'No camera was found on this station. Scan from a photo instead.'
  if (error?.name === 'NotReadableError') return 'The camera is in use by another app. Close it and try again.'
  return 'The camera could not be started. Scan from a photo instead.'
}

function BarcodeScanner({ autoStart = false, onDetected }) {
  const [scanState, setScanState] = useState(autoStart ? 'starting' : 'idle')
  const [aiMode, setAiMode] = useState(false)
  const [message, setMessage] = useState('')
  const [lastCode, setLastCode] = useState(null)
  const videoRef = useRef(null)
  const fileInputRef = useRef(null)
  const onDetectedRef = useRef(onDetected)

  useEffect(() => {
    onDetectedRef.current = onDetected
  }, [onDetected])

  const scanning = scanState === 'starting' || scanState === 'scanning'
  const showVideo = scanning && !aiMode

  useEffect(() => {
    if (!showVideo) return undefined

    let cancelled = false
    let controls = null

    loadReader()
      .then((reader) => reader.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } }, audio: false },
        videoRef.current,
        (result, _error, activeControls) => {
          if (!result || cancelled) return
          cancelled = true
          activeControls.stop()
          const code = { text: result.getText(), format: formatName(result.getBarcodeFormat()) }
          setLastCode(code)
          setScanState('detected')
          setMessage('')
          onDetectedRef.current(code.text)
        },
      ))
      .then((activeControls) => {
        if (cancelled) activeControls.stop()
        else {
          controls = activeControls
          setScanState((current) => (current === 'starting' ? 'scanning' : current))
        }
      })
      .catch((error) => {
        if (cancelled) return
        setScanState('error')
        setMessage(cameraErrorMessage(error))
      })

    return () => {
      cancelled = true
      controls?.stop()
    }
  }, [showVideo])

  const startCamera = () => {
    setLastCode(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setScanState('error')
      setMessage('Camera scanning is not supported in this browser. Scan from a photo instead.')
      return
    }
    setMessage('')
    setScanState('starting')
  }

  const stopCamera = () => {
    setScanState('idle')
    setMessage('')
  }

  const scanPhoto = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setScanState('error')
      setMessage('Choose an image file that shows the barcode or QR code.')
      return
    }

    setScanState('reading')
    setMessage('')
    const url = URL.createObjectURL(file)
    try {
      const reader = await loadReader()
      const result = await reader.decodeFromImageUrl(url)
      const code = { text: result.getText(), format: formatName(result.getBarcodeFormat()) }
      setLastCode(code)
      setScanState('detected')
      onDetectedRef.current(code.text)
    } catch {
      setScanState('error')
      setMessage('No barcode or QR code was found in that photo. Try a closer, sharper shot with the whole code in frame.')
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  const cameraScreen = showVideo || scanState === 'error' && message.includes('camera')
  return <>
    <h1>{aiMode ? 'Identify with AI' : cameraScreen ? 'Scan with camera' : 'Identify return'}</h1>
    <p className="touch-subtitle">{aiMode ? 'Find an item using a product photo.' : cameraScreen ? 'Hold the code inside the guide. It will be read automatically.' : 'Scan a code or identify an item with AI to get started.'}</p>
    {aiMode ? <AiIdentify onBack={() => setAiMode(false)} onDetected={onDetected} /> : cameraScreen ? <div className="touch-camera-grid">
      <div className="touch-camera-preview" style={{backgroundImage: `linear-gradient(#182e2755, #182e2755), url(${preview})`}}>
        {showVideo && <video ref={videoRef} autoPlay playsInline muted aria-label="Live camera preview" />}
        <span className="preview-caption">▣ {showVideo ? 'Station camera' : 'Illustrative camera preview'}</span><span className="touch-scan-guide"><i /></span><span className="scan-looking" role="status">⌗ {scanState === 'error' ? 'Camera unavailable' : 'Looking for a code…'}</span>
      </div><aside className="camera-help"><section className="touch-card"><span className="camera-shield"><TouchIcon name="shield" /></span><h2>Allow camera access</h2><p>{message || 'The first time, choose Allow in your browser’s camera prompt.'}</p><small>Camera access requires localhost or HTTPS.</small></section><button className="touch-secondary" onClick={stopCamera}>Cancel scan</button></aside>
    </div> : <section className="touch-scan-card">
      <div className="touch-barcode"><img src={barcodeScanner} alt="Barcode and QR code" /><span>Barcodes &amp; QR codes</span></div><div className="touch-scan-actions"><h2>Choose how to identify</h2><button className="touch-primary" onClick={startCamera}><TouchIcon name="camera" /> Scan with camera</button><button className="touch-secondary" onClick={() => setAiMode(true)}><TouchIcon name="sparkles" /> Identify with AI</button><button className="touch-secondary" onClick={() => fileInputRef.current?.click()} disabled={scanState === 'reading'}><TouchIcon name="photo" /> {scanState === 'reading' ? 'Reading photo…' : 'Scan from photo'}</button><p role="status">{message || (lastCode ? `Read ${lastCode.text}` : 'Scan a barcode or QR code, or use AI to identify the item.')}</p></div>
    </section>}
    <input ref={fileInputRef} className="sr-only" type="file" accept="image/*" onChange={scanPhoto} tabIndex={-1} aria-label="Choose barcode photo" />
  </>
}

export default BarcodeScanner

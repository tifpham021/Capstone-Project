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

function BarcodeScanner({ autoStart = false, onDetected, onOrderLookup }) {
  const [scanState, setScanState] = useState(autoStart ? 'starting' : 'idle')
  const [aiMode, setAiMode] = useState(false)
  const [identifyMethod, setIdentifyMethod] = useState('scan')
  const [orderNumber, setOrderNumber] = useState('')
  const [orderState, setOrderState] = useState('idle')
  const [orderMessage, setOrderMessage] = useState('')
  const [message, setMessage] = useState('')
  const [lastCode, setLastCode] = useState(null)
  const videoRef = useRef(null)
  const fileInputRef = useRef(null)
  const onDetectedRef = useRef(onDetected)

  useEffect(() => {
    onDetectedRef.current = onDetected
  }, [onDetected])

  const scanning = scanState === 'starting' || scanState === 'scanning'
  const orderMode = identifyMethod === 'order'
  const showVideo = scanning && !aiMode && !orderMode

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

  const chooseMethod = (method) => {
    setIdentifyMethod(method)
    setOrderMessage('')
    if (method === 'order') {
      setAiMode(false)
      setScanState('idle')
      setMessage('')
    }
  }

  const submitOrder = async (event) => {
    event.preventDefault()
    const value = orderNumber.trim()
    if (!value || orderState === 'loading') return

    setOrderState('loading')
    setOrderMessage(`Looking up ${value}…`)
    try {
      await onOrderLookup(value)
    } catch (error) {
      setOrderState('error')
      setOrderMessage(error.message || 'That order could not be found. Check the number and try again.')
    }
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

  const cameraScreen = !orderMode && (showVideo || scanState === 'error' && message.includes('camera'))
  return <>
    <h1>{aiMode ? 'Identify with AI' : cameraScreen ? 'Scan with camera' : 'Identify return'}</h1>
    <p className="touch-subtitle">{aiMode ? 'Find an item using a product photo.' : cameraScreen ? 'Hold the code inside the guide. It will be read automatically.' : 'Scan a code or enter an order number to get started.'}</p>
    {aiMode ? <AiIdentify onBack={() => setAiMode(false)} onDetected={onDetected} /> : cameraScreen ? <div className="touch-camera-grid">
      <div className="touch-camera-preview" style={{backgroundImage: `linear-gradient(#182e2755, #182e2755), url(${preview})`}}>
        {showVideo && <video ref={videoRef} autoPlay playsInline muted aria-label="Live camera preview" />}
        <span className="preview-caption">▣ {showVideo ? 'Station camera' : 'Illustrative camera preview'}</span><span className="touch-scan-guide"><i /></span><span className="scan-looking" role="status">⌗ {scanState === 'error' ? 'Camera unavailable' : 'Looking for a code…'}</span>
      </div><aside className="camera-help"><section className="touch-card"><span className="camera-shield"><TouchIcon name="shield" /></span><h2>Allow camera access</h2><p>{message || 'The first time, choose Allow in your browser’s camera prompt.'}</p><small>Camera access requires localhost or HTTPS.</small></section><button className="touch-secondary" onClick={stopCamera}>Cancel scan</button></aside>
    </div> : <section className={`touch-scan-card${orderMode ? ' order-lookup-mode' : ''}`}>
      <div className="touch-barcode">
        {orderMode ? (
          <><span className="touch-order-icon"><TouchIcon name="search" /></span><strong>Order lookup</strong><span>Use the number from the receipt or return label.</span></>
        ) : (
          <><img src={barcodeScanner} alt="Barcode and QR code" /><span>Barcodes &amp; QR codes</span></>
        )}
      </div>
      <div className="touch-scan-actions">
        <span className="touch-method-label">Lookup method</span>
        <div className="touch-identify-methods" role="group" aria-label="Identification method">
          <button type="button" className={orderMode ? '' : 'active'} aria-pressed={!orderMode} onClick={() => chooseMethod('scan')}><TouchIcon /> Scan code</button>
          <button type="button" className={orderMode ? 'active' : ''} aria-pressed={orderMode} onClick={() => chooseMethod('order')}><TouchIcon name="search" /> Order number</button>
        </div>
        {orderMode ? (
          <form className="touch-order-form" onSubmit={submitOrder}>
            <label htmlFor="touch-order-number">Order number</label>
            <div className="touch-order-entry">
              <input
                id="touch-order-number"
                value={orderNumber}
                onChange={(event) => {
                  setOrderNumber(event.target.value)
                  setOrderState('idle')
                  setOrderMessage('')
                }}
                placeholder="Example: ORD-8921"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck="false"
                enterKeyHint="search"
                disabled={orderState === 'loading'}
              />
              <button className="touch-primary" disabled={!orderNumber.trim() || orderState === 'loading'}>
                {orderState === 'loading' ? 'Finding…' : 'Find return'}
              </button>
            </div>
            <p className={orderState === 'error' ? 'touch-order-status error' : 'touch-order-status'} role="status">{orderMessage || 'Enter the complete order number, including any letters.'}</p>
          </form>
        ) : (
          <>
            <button className="touch-primary" onClick={startCamera}><TouchIcon name="camera" /> Scan with camera</button>
            <span className="touch-alternative-label" aria-hidden="true">Other ways to identify</span>
            <div className="touch-scan-secondary-row">
              <button className="touch-secondary" onClick={() => setAiMode(true)}><TouchIcon name="sparkles" /> Identify with AI</button>
              <button className="touch-secondary" onClick={() => fileInputRef.current?.click()} disabled={scanState === 'reading'}><TouchIcon name="photo" /> {scanState === 'reading' ? 'Reading…' : 'From photo'}</button>
            </div>
            <p className="touch-scan-status" role="status">{message || (lastCode ? `Read ${lastCode.text}` : 'Scan a barcode or QR code, or use a clear photo.')}</p>
          </>
        )}
      </div>
    </section>}
    <input ref={fileInputRef} className="sr-only" type="file" accept="image/*" onChange={scanPhoto} tabIndex={-1} aria-label="Choose barcode photo" />
  </>
}

export default BarcodeScanner

import { useEffect, useRef, useState } from 'react'
import barcodeScanner from './assets/figma/c6ae5.svg'
import clockIcon from './assets/figma/557ea.svg'
import clockHand from './assets/figma/b4663.svg'

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

function BarcodeScanner({ mode, autoDetect, onDetected }) {
  const [scanState, setScanState] = useState('idle')
  const [message, setMessage] = useState('')
  const [lastCode, setLastCode] = useState(null)
  const videoRef = useRef(null)
  const fileInputRef = useRef(null)
  const onDetectedRef = useRef(onDetected)

  useEffect(() => {
    onDetectedRef.current = onDetected
  }, [onDetected])

  const scanning = scanState === 'starting' || scanState === 'scanning'
  const orderMode = mode === 'order'
  // Switching to Order ID unmounts the preview, which stops the camera.
  const showVideo = scanning && !orderMode

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

  let title = 'Ready to scan'
  let detail = 'Hold the code 6 to 12 inches from the scanner, or use the camera.'
  if (orderMode) {
    title = 'Order lookup selected'
    detail = 'Enter the return identifier below to continue'
  } else if (scanState === 'reading') {
    title = 'Reading photo…'
    detail = 'Looking for a barcode or QR code in the image.'
  } else if (scanState === 'detected' && lastCode) {
    title = `${lastCode.format} detected`
    detail = autoDetect
      ? `Read ${lastCode.text} and looked it up automatically.`
      : `Read ${lastCode.text}. Press Find return to continue.`
  } else if (scanState === 'error') {
    title = 'Scan not completed'
    detail = message
  }

  return (
    <div className={`scanner-panel${orderMode ? ' order-mode' : ''}${showVideo ? ' camera-live' : ''}${scanState === 'detected' && !orderMode ? ' detected' : ''}`}>
      <span className="scanner-ready">
        <i />
        {showVideo ? (scanState === 'starting' ? 'Starting camera…' : 'Camera scanning') : 'Scanner ready'}
      </span>

      {showVideo ? (
        <>
          <video ref={videoRef} className="scanner-video" autoPlay playsInline muted aria-label="Live camera preview" />
          <span className="scanner-guide" aria-hidden="true"><i /></span>
          <p className="scanner-video-hint" aria-live="polite">Center the barcode or QR code inside the frame. It is read automatically.</p>
          <button type="button" className="scanner-stop" onClick={stopCamera}>Stop camera</button>
        </>
      ) : (
        <>
          <img className="barcode-art" src={barcodeScanner} alt="Barcode framed by scanner guides" />
          <h3>{title}</h3>
          <p aria-live="polite">{detail}</p>
          {orderMode ? null : (
            <div className="scanner-actions">
              <button type="button" className="scanner-action primary" onClick={startCamera}>
                {scanState === 'detected' || scanState === 'error' ? 'Scan again with camera' : 'Scan with camera'}
              </button>
              <button
                type="button"
                className="scanner-action"
                onClick={() => fileInputRef.current?.click()}
                disabled={scanState === 'reading'}
              >
                Scan from photo
              </button>
            </div>
          )}
          <span className="auto-detect">
            <span className="layered-icon clock">
              <img src={clockIcon} alt="" />
              <img src={clockHand} alt="" />
            </span>
            {orderMode
              ? 'Manual lookup is enabled'
              : autoDetect ? 'Auto-detect is enabled' : 'Auto-detect is off'}
          </span>
        </>
      )}

      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept="image/*"
        onChange={scanPhoto}
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  )
}

export default BarcodeScanner

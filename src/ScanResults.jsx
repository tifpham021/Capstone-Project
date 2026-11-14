import './ScanResults.css'
import VisualFindings from './VisualFindings.jsx'
import { artifactUrl } from './scanApi.js'

function ComparisonImage({ path, label }) {
  const url = artifactUrl(path)
  if (!url) return null
  return (
    <figure className="scan-figure">
      <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${label}`}>
        <img src={url} alt={label} />
      </a>
      <figcaption>{label}</figcaption>
    </figure>
  )
}

export default function ScanResults({ scan }) {
  if (!scan?.results) return null
  return (
    <div className="scan-results">
      {scan.results.map(({ camera_id: cameraId, result, error }) => (
        <article className="scan-view" key={`${scan.scan_id}-${cameraId}`} aria-label={`Camera ${cameraId + 1} result`}>
          {error ? <p className="scan-error" role="alert">{error}</p> : result ? (
            <>
              <div className="scan-normalized">
                <ComparisonImage path={result.annotated_reference_image_url || result.reference_image_url} label="Reference" />
                <ComparisonImage path={result.annotated_image_url || result.original_image_url} label="Captured item" />
              </div>
              <VisualFindings verification={result} />
            </>
          ) : null}
        </article>
      ))}
    </div>
  )
}

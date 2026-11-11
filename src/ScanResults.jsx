import { useState } from 'react'
import { artifactUrl } from './scanApi.js'
import './ScanResults.css'

function ResultImage({ path, label }) {
  const [failed, setFailed] = useState(false)
  const url = artifactUrl(path)
  return (
    <figure className="scan-figure">
      {failed || !url ? <p role="alert">Image unavailable. Check backend access.</p> : (
        <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${label}`}>
          <img src={url} alt={label} onError={() => setFailed(true)} />
        </a>
      )}
      <figcaption>{label} · Click to enlarge</figcaption>
    </figure>
  )
}

export default function ScanResults({ scan }) {
  if (!scan?.results) return <p className="scan-empty">No scan results yet. Place the item under both cameras and press Scan item.</p>
  return (
    <div className="scan-results">
      <p>Captured {new Date(scan.captured_at * 1000).toLocaleString()}. Each camera is compared independently with enrolled references.</p>
      {scan.results.map(({ camera_id: cameraId, result, error }) => (
        <article className="scan-view" key={`${scan.scan_id}-${cameraId}`}>
          <h3>Camera {cameraId + 1}</h3>
          {error ? <p className="scan-error" role="alert">{error}</p> : result ? (
            <>
              {result.normalized_reference_image_url && result.normalized_image_url ? (
                <div className="scan-normalized">
                  <ResultImage key={`${result.request_id}-reference`} path={result.normalized_reference_image_url} label="Genuine reference" />
                  <ResultImage key={`${result.request_id}-normalized`} path={result.normalized_image_url} label="Returned item" />
                </div>
              ) : <p>Scan again to generate normalized comparison images.</p>}
              {result.normalized_image_url && <p>{result.background_removed ? 'Backgrounds removed.' : 'Background removal failed; original backgrounds are retained.'} {result.normalization_alignment === 'matched_geometry' ? 'The returned item is rotated and aligned to the reference view.' : 'Views are oriented independently; matching perspective could not be established. Retake a view closer to the reference.'}</p>}
              <div className="scan-summary">
                <strong>{result.confidence_percent.toFixed(1)}% visual match</strong>
                <span className={`scan-decision ${result.decision}`}>{result.decision}</span>
                <span>{result.compared_product.name}</span>
              </div>
              <p>This visual-match score is not an authenticity probability.</p>
              <dl className="scan-metrics">
                <div><dt>Geometry</dt><dd>{(result.geometry.score * 100).toFixed(1)}%</dd></div>
                <div><dt>Patch normality</dt><dd>{(result.patchcore.normality_score * 100).toFixed(1)}%</dd></div>
                <div><dt>Alignment</dt><dd>{result.geometry.alignment_valid ? 'Valid' : 'Failed — retake view'}</dd></div>
                <div><dt>Discrepancy regions</dt><dd>{result.discrepancy_regions.length}</dd></div>
              </dl>
              {result.geometry.backend === 'ALIKED+LightGlue' && result.geometry.alignment_valid && result.background_removed && result.discrepancy_image_url ? (
                <section className="scan-analysis" aria-label="Major discrepancies">
                  <h4>Major line and shape differences</h4>
                  <p>{result.discrepancy_regions.length ? 'Boxes mark changed or missing edges after alignment. Review them against the reference above.' : 'No major line differences detected. This does not establish authenticity.'}</p>
                  <div className="scan-discrepancy">
                    <ResultImage key={`${result.request_id}-differences`} path={result.discrepancy_image_url} label="Returned item · Major differences boxed" />
                  </div>
                </section>
              ) : <p>Discrepancy highlighting requires a valid LightGlue alignment and successful background removal. Matching used: {result.geometry.backend}.</p>}
              <ul>{result.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              {result.warnings.length > 0 && <ul className="scan-warnings">{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
            </>
          ) : <p role="alert">No result returned for this camera.</p>}
        </article>
      ))}
    </div>
  )
}

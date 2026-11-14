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
      {scan.order && <section className="scan-order-comparison" aria-label="Order and weight comparison">
        <div className="scan-summary"><div><span>Order {scan.order.order_number}</span><h3>{scan.order.product_name}</h3></div>
          {scan.decision && <strong className={`scan-decision ${scan.decision}`}>{scan.decision === 'consistent' ? 'Image and weight checks consistent' : scan.decision === 'suspicious' ? 'Differences detected — review required' : 'Some checks are inconclusive'}</strong>}
        </div>
        {scan.weight && <>
          <div className="scan-weight-heading"><h4>Weight comparison</h4><span className="scan-demo-badge">Simulated sensor · demo</span></div>
          <dl className="scan-weight-metrics">
            <div><dt>Expected</dt><dd>{scan.weight.expected_weight_g.toFixed(2)} g</dd></div>
            <div><dt>Measured (simulated)</dt><dd>{scan.weight.measured_weight_g.toFixed(2)} g</dd></div>
            <div><dt>Difference</dt><dd>{scan.weight.difference_g >= 0 ? '+' : ''}{scan.weight.difference_g.toFixed(2)} g ({scan.weight.difference_percent >= 0 ? '+' : ''}{scan.weight.difference_percent.toFixed(2)}%)</dd></div>
            <div><dt>Tolerance</dt><dd>±{scan.weight.tolerance_percent}%</dd></div>
            <div><dt>Result</dt><dd className={scan.weight.within_tolerance ? 'weight-pass' : 'weight-fail'}>{scan.weight.within_tolerance ? 'Within tolerance' : 'Outside tolerance'}</dd></div>
          </dl>
        </>}
      </section>}
      <p>Captured {new Date(scan.captured_at * 1000).toLocaleString()}. Each camera is compared independently with enrolled references.</p>
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

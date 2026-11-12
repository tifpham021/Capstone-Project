import './VisualFindings.css'

const labels = {
  damage: 'Damage',
  different_item: 'Different product',
  missing_parts: 'Missing parts',
  counterfeit_evidence: 'Counterfeit indicators',
  insufficient_visual_evidence: 'Insufficient visual evidence',
}
const statuses = { present: 'Flagged', absent: 'None observed', unknown: 'Uncertain' }

export default function VisualFindings({ verification }) {
  if (!verification?.flags) return null
  const elapsed = verification.latency_ms?.total
  return (
    <section className="visual-findings" aria-label="Visual inspection findings">
      <div className="visual-findings-heading">
        <h3>Visual inspection</h3>
        {elapsed != null && <span>{(elapsed / 1000).toFixed(2)} s</span>}
      </div>
      <dl className="visual-flags">
        {Object.entries(verification.flags).map(([key, flag]) => (
          <div key={key} className={`visual-flag ${flag.status}`}>
            <dt>{labels[key] || key}</dt>
            <dd><strong>{statuses[flag.status] || flag.status}</strong><span>{Math.round(flag.confidence * 100)}% confidence</span></dd>
            <p>{flag.evidence}</p>
          </div>
        ))}
      </dl>
      {verification.discrepancies?.length > 0 && (
        <ol className="visual-discrepancies" aria-label="Numbered image discrepancies">
          {verification.discrepancies.map((item, index) => (
            <li key={index}>{item.description} <span>{Math.round(item.confidence * 100)}%</span></li>
          ))}
        </ol>
      )}
      <p className="visual-confidence-note">Confidence is a model estimate. The reviewer makes the final decision.</p>
    </section>
  )
}

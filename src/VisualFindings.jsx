import './VisualFindings.css'

const statuses = { present: 'Yes', absent: 'No', unknown: 'Unknown' }

export default function VisualFindings({ verification }) {
  const confidence = verification?.confidence_percent
  return (
    <dl className="visual-findings visual-flags">
      <div className="visual-flag">
        <dt>Overall confidence</dt>
        <dd><strong>{Number.isFinite(confidence) ? `${confidence.toFixed(1)}%` : 'Unknown'}</strong></dd>
      </div>
      {[['damage', 'Damage flag'], ['different_item', 'Different item flag']].map(([key, label]) => {
        const status = verification?.flags?.[key]?.status
        return (
          <div key={key} className={`visual-flag ${status || 'unknown'}`}>
            <dt>{label}</dt>
            <dd><strong>{statuses[status] || 'Unknown'}</strong></dd>
          </div>
        )
      })}
    </dl>
  )
}

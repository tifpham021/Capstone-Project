import TouchIcon from './TouchIcon.jsx'
import { useState } from 'react'
import preview from './assets/station-preview.png'

export function TouchVerification({ returnCase, onBack, onContinue }) {
  const [name, setName] = useState(returnCase.productName)
  const [editing, setEditing] = useState(false)
  return <main id="main" className="touch-main verification">
    <h1>Verify item</h1><p className="touch-subtitle">Compare the camera views and scale reading before continuing.</p>
    <div className="verify-grid">
      <section className="touch-card verify-details">
        <div className="touch-row"><strong><TouchIcon /> Item verified</strong><span className="touch-pill">Visual + weight</span></div>
        <label htmlFor="item-name">Scanned return identity</label>
        <div className="identity-input"><input id="item-name" value={name} readOnly={!editing} onChange={e => setName(e.target.value)} /><button aria-label={editing ? 'Save item identity' : 'Edit item identity'} onClick={() => setEditing(!editing)}>{editing ? '✓' : '✎'}</button></div>
        <div className="weight-summary"><div className="touch-row"><strong>Weight comparison</strong><span className="touch-pill">99.4% Match</span></div><div className="touch-row"><span>Expected weight</span><strong>1.62 kg</strong></div><div className="touch-row"><span>Scale measured</span><strong>1.61 kg</strong></div></div>
      </section>
      <div className="verify-cameras">{['Top-down camera', 'Side-angle camera'].map(label => <section className="verify-camera" key={label}><div className="touch-row"><strong>{label}</strong><span className="touch-pill">Verified</span></div><div className="evidence-preview" style={{backgroundImage: `url(${preview})`}}><span>▣ Illustrative camera preview</span></div></section>)}</div>
    </div>
    <div className="verify-actions"><button className="touch-secondary" onClick={onBack}><TouchIcon /> Retry scan</button><button className="touch-primary" onClick={() => onContinue(name.trim() || returnCase.productName)}>→ Continue</button></div>
  </main>
}

import { useEffect, useState } from 'react'

export default function SimulatedWeight({ estimate }) {
  const base = estimate?.estimated_weight_g
  const valid = Number.isFinite(base) && base > 0
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    if (!valid) return undefined
    // Bounded jitter around the original estimate; it never accumulates drift.
    const amplitude = Math.min(5, base * 0.005)
    const timer = window.setInterval(() => {
      setOffset((Math.random() * 2 - 1) * amplitude)
    }, 900)
    return () => window.clearInterval(timer)
  }, [base, valid])

  return <section className="simulated-weight" aria-label="Measured weight">
    <h3>Measured weight</h3>
    {valid ? <>
      <output aria-label="Measured weight in grams" aria-live="off">{Math.max(1, Math.round(base + offset)).toLocaleString()} <small>g</small></output>
      <p>{estimate.product_name}</p>
    </> : <p>Weight unavailable. Scan again to retry.</p>}
  </section>
}

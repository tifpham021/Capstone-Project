import { useCallback, useEffect, useState } from 'react'
import { scanRequest } from './scanApi.js'

// Enrolled objects from GET /v1/products. Call reload() after enrolling.
export default function useProducts() {
  const [state, setState] = useState({ products: [], error: '', loaded: false })
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    scanRequest('/v1/products', { signal: controller.signal })
      .then((body) => setState({ products: body.products || [], error: '', loaded: true }))
      .catch((err) => {
        if (!controller.signal.aborted) {
          setState((current) => ({ ...current, error: `Could not load enrolled objects: ${err.message}`, loaded: true }))
        }
      })
    return () => controller.abort()
  }, [version])

  const reload = useCallback(() => setVersion((value) => value + 1), [])
  return { ...state, reload }
}

// Relative URLs use Vite's server-side proxy, including protected artifact images.
const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

export function artifactUrl(path) {
  if (!path?.startsWith('/v1/results/')) return ''
  return `${base}${path}`
}

export async function scanRequest(path, options = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timer = setTimeout(abort, 15000)
  try {
    const response = await fetch(`${base}${path}`, { ...options, signal: controller.signal })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.detail || `Backend returned HTTP ${response.status}`)
    return body
  } catch (error) {
    if (error.name === 'AbortError' && options.signal?.aborted) throw error
    throw new Error(error.name === 'AbortError' ? 'Backend request timed out. Check the server.' : error.message, { cause: error })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

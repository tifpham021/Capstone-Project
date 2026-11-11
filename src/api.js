// Calls to the ReturnScan backend (FastAPI in backend/). Shared by both UIs.
// The base URL is public browser config; never put secrets in VITE_ variables.

export const API_BASE = (import.meta.env.VITE_AI_API_BASE || 'http://127.0.0.1:8000').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(message, { status = 0, offline = false } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.offline = offline
  }
}

// Turns a server path like /v1/order-images/3 into a full URL for <img src>.
export const apiUrl = (path) => (path ? `${API_BASE}${path}` : '')

async function request(path, { method = 'GET', json, form, timeoutMs = 20000 } = {}) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: json ? { 'Content-Type': 'application/json' } : undefined,
      body: json ? JSON.stringify(json) : form,
    })
  } catch (failure) {
    throw new ApiError(
      failure.name === 'AbortError'
        ? 'The server took too long to respond.'
        : 'Cannot reach the ReturnScan server. Check that the backend is running.',
      { offline: true },
    )
  } finally {
    window.clearTimeout(timer)
  }

  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = typeof body?.detail === 'string' ? body.detail : `Request failed (${response.status})`
    throw new ApiError(detail, { status: response.status })
  }
  return body
}

const photoForm = (file, fields = {}) => {
  const form = new FormData()
  form.append('file', file)
  Object.entries(fields).forEach(([key, value]) => {
    if (value !== undefined && value !== null) form.append(key, value)
  })
  return form
}

export const searchOrders = (search) =>
  request(`/v1/orders?${new URLSearchParams({ search, limit: '10' })}`)

export const createReturn = (body) => request('/v1/returns', { method: 'POST', json: body })

export const getReturn = (returnId) => request(`/v1/returns/${encodeURIComponent(returnId)}`)

export const setReturnStatus = (returnId, status) =>
  request(`/v1/returns/${encodeURIComponent(returnId)}/status`, { method: 'POST', json: { status } })

export const recordWeight = (returnId, measuredWeightG) =>
  request(`/v1/returns/${encodeURIComponent(returnId)}/weight`, {
    method: 'POST',
    json: { measured_weight_g: measuredWeightG },
  })

export const uploadReturnImage = (returnId, file, view = 'other') =>
  request(`/v1/returns/${encodeURIComponent(returnId)}/images`, {
    method: 'POST',
    form: photoForm(file, { view }),
    timeoutMs: 60000,
  })

// Runs the CV comparison against the product's reference photos. The first call
// after the backend starts can be slow while the models load.
export const verifyPhoto = (file, expectedProductId) =>
  request('/v1/verify', {
    method: 'POST',
    form: photoForm(file, { expected_product_id: expectedProductId }),
    timeoutMs: 180000,
  })

export const attachVerification = (returnId, requestId) =>
  request(`/v1/returns/${encodeURIComponent(returnId)}/verifications`, {
    method: 'POST',
    json: { request_id: requestId },
  })

export const recordDecision = (returnId, body) =>
  request(`/v1/returns/${encodeURIComponent(returnId)}/decision`, { method: 'POST', json: body })

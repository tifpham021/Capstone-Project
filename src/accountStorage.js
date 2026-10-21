// Per-account data kept in the browser: reviewer preferences and the decisions
// the reviewer has recorded. Keyed by email so accounts on a shared station
// do not see each other's history.

export const DEFAULT_PREFERENCES = Object.freeze({
  defaultLookupMode: 'barcode',
  autoDetect: true,
  queueNotifications: true,
})

const MAX_HISTORY = 50

function storageKey(kind, email) {
  return `returnscan.${kind}.${email.toLowerCase()}`
}

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage may be full or blocked; the in-memory state still applies.
  }
}

export function loadPreferences(email) {
  return { ...DEFAULT_PREFERENCES, ...readJson(storageKey('preferences', email), {}) }
}

export function savePreferences(email, preferences) {
  writeJson(storageKey('preferences', email), preferences)
}

export function loadDecisionHistory(email) {
  return readJson(storageKey('history', email), [])
}

export function saveDecisionHistory(email, history) {
  writeJson(storageKey('history', email), history.slice(0, MAX_HISTORY))
}

export function clearDecisionHistory(email) {
  try {
    window.localStorage.removeItem(storageKey('history', email))
  } catch {
    // Nothing stored to clear.
  }
}

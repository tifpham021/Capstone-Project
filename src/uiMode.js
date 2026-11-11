// Chooses which UI the app renders:
//   'desktop' - the computer workstation UI
//   'touch'   - the Raspberry Pi touchscreen UI
//
// Priority: ?ui=touch|desktop in the URL (remembered in this browser),
// then a previously remembered choice, then VITE_UI_MODE, then 'touch'.
// Use ?ui=default to forget the remembered choice and fall back to VITE_UI_MODE.

export const UI_MODES = ['desktop', 'touch']
const STORAGE_KEY = 'returnscan.uiMode'

const normalize = (value) => {
  const mode = String(value || '').trim().toLowerCase()
  return UI_MODES.includes(mode) ? mode : null
}

export function resolveUiMode() {
  const fromEnv = normalize(import.meta.env.VITE_UI_MODE) || 'touch'
  const fromUrl = new URLSearchParams(window.location.search).get('ui')

  try {
    if (fromUrl === 'default') {
      window.localStorage.removeItem(STORAGE_KEY)
      return fromEnv
    }
    if (normalize(fromUrl)) {
      window.localStorage.setItem(STORAGE_KEY, normalize(fromUrl))
      return normalize(fromUrl)
    }
    return normalize(window.localStorage.getItem(STORAGE_KEY)) || fromEnv
  } catch {
    // Storage can be blocked (private mode); the URL and env still work.
    return normalize(fromUrl) || fromEnv
  }
}

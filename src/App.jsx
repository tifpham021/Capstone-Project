import { Suspense, lazy } from 'react'
import { resolveUiMode } from './uiMode.js'

// Each UI is loaded on demand so only its own CSS is injected. The UIs
// share class names (e.g. the login page) and the touch UI sets global
// :root colours, so loading both at once would make them clash.
const DesktopApp = lazy(() => import('./DesktopApp.jsx'))
const TouchApp = lazy(() => import('./TouchApp.jsx'))
const PiApp = lazy(() => import('./PiApp.jsx'))
const apps = { desktop: DesktopApp, touch: TouchApp, pi: PiApp }

const uiMode = resolveUiMode()
document.documentElement.dataset.ui = uiMode

function App() {
  const SelectedApp = apps[uiMode]
  return (
    <Suspense fallback={null}>
      <SelectedApp />
    </Suspense>
  )
}

export default App

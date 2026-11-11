import { Suspense, lazy } from 'react'
import { resolveUiMode } from './uiMode.js'

// Each UI is loaded on demand so only its own CSS is injected. The two UIs
// share class names (e.g. the login page) and the touch UI sets global
// :root colours, so loading both at once would make them clash.
const DesktopApp = lazy(() => import('./DesktopApp.jsx'))
const TouchApp = lazy(() => import('./TouchApp.jsx'))

const uiMode = resolveUiMode()
document.documentElement.dataset.ui = uiMode

function App() {
  const SelectedApp = uiMode === 'touch' ? TouchApp : DesktopApp
  return (
    <Suspense fallback={null}>
      <SelectedApp />
    </Suspense>
  )
}

export default App

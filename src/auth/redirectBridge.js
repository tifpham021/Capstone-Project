// Runs in the Microsoft sign-in popup after it redirects back to the app and
// hands the response to the main window, which then closes the popup.
import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge'

broadcastResponseToMainFrame().catch(() => {
  window.close()
})

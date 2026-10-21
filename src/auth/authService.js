// Client-side authentication for the ReturnScan prototype.
// Google and Microsoft sign-in use real OAuth popups when client IDs are set in
// .env.local. Email sign-in checks a built-in list of demo accounts, because
// the prototype has no backend to verify passwords against.

export const AUTH_PROVIDER = Object.freeze({
  EMAIL: 'email',
  GOOGLE: 'google',
  MICROSOFT: 'microsoft',
})

export const PROVIDER_LABELS = Object.freeze({
  [AUTH_PROVIDER.EMAIL]: 'Email and password',
  [AUTH_PROVIDER.GOOGLE]: 'Google',
  [AUTH_PROVIDER.MICROSOFT]: 'Microsoft',
})

const SESSION_KEY = 'returnscan.session'
const GOOGLE_SCRIPT_URL = 'https://accounts.google.com/gsi/client'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''
const microsoftClientId = import.meta.env.VITE_MICROSOFT_CLIENT_ID || ''
const microsoftTenantId = import.meta.env.VITE_MICROSOFT_TENANT_ID || 'common'

export const providerConfigured = Object.freeze({
  [AUTH_PROVIDER.GOOGLE]: Boolean(googleClientId),
  [AUTH_PROVIDER.MICROSOFT]: Boolean(microsoftClientId),
})

const demoAccounts = [
  {
    email: 'jane.doe@returnscan.com',
    password: 'ReturnScan2026!',
    name: 'Jane Doe',
    role: 'Reviewer',
    station: 'Station 01',
  },
  {
    email: 'alex.kim@returnscan.com',
    password: 'ReturnScan2026!',
    name: 'Alex Kim',
    role: 'Supervisor',
    station: 'Station 04',
  },
]

export const DEMO_CREDENTIALS = {
  email: demoAccounts[0].email,
  password: demoAccounts[0].password,
}

// Tokens stay in memory only; they are needed to revoke access on sign-out.
let googleAccessToken = null
let msalInstancePromise = null

function readStorage(storage) {
  try {
    const raw = storage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function clearStoredSession() {
  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      storage.removeItem(SESSION_KEY)
    } catch {
      // Storage can be unavailable in private browsing; nothing to clear.
    }
  }
}

function storeSession(session, remember) {
  clearStoredSession()
  try {
    const storage = remember ? window.localStorage : window.sessionStorage
    storage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    // The session still works for this page load without storage.
  }
}

export function loadSession() {
  return readStorage(window.localStorage) || readStorage(window.sessionStorage)
}

function createSession(user, provider, remember) {
  const session = {
    user: {
      station: 'Station 01',
      role: 'Reviewer',
      ...user,
      initials: getInitials(user.name || user.email),
    },
    provider,
    signedInAt: new Date().toISOString(),
    remember,
  }
  storeSession(session, remember)
  return session
}

export function getInitials(name) {
  const parts = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean)
  return parts.slice(0, 2).map((part) => part[0].toUpperCase()).join('') || '?'
}

export async function signInWithEmail(email, password, remember) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail || !password) {
    throw new Error('Enter your email address and password.')
  }

  const account = demoAccounts.find((candidate) => candidate.email === normalizedEmail)
  if (!account || account.password !== password) {
    throw new Error('That email and password combination was not recognized.')
  }

  const { name, email: accountEmail, role, station } = account
  return createSession({ name, email: accountEmail, role, station }, AUTH_PROVIDER.EMAIL, remember)
}

function loadGoogleScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GOOGLE_SCRIPT_URL}"]`)
    const script = existing || document.createElement('script')
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error('Google sign-in could not be loaded. Check your connection.')), { once: true })
    if (!existing) {
      script.src = GOOGLE_SCRIPT_URL
      script.async = true
      document.head.appendChild(script)
    }
  })
}

export async function signInWithGoogle(remember) {
  if (!providerConfigured[AUTH_PROVIDER.GOOGLE]) {
    throw new Error('Google sign-in is not configured. Add VITE_GOOGLE_CLIENT_ID to .env.local and restart the dev server.')
  }

  await loadGoogleScript()

  const tokenResponse = await new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: googleClientId,
      scope: 'openid email profile',
      prompt: 'select_account',
      callback: (response) => {
        if (response.error) reject(new Error(response.error_description || 'Google sign-in was not completed.'))
        else resolve(response)
      },
      error_callback: (error) => {
        reject(new Error(error?.type === 'popup_closed'
          ? 'The Google sign-in window was closed before finishing.'
          : 'Google sign-in was not completed.'))
      },
    })
    client.requestAccessToken()
  })

  const profileResponse = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
  })
  if (!profileResponse.ok) throw new Error('Your Google profile could not be read.')

  const profile = await profileResponse.json()
  googleAccessToken = tokenResponse.access_token
  return createSession({
    name: profile.name || profile.email,
    email: profile.email,
    picture: profile.picture,
  }, AUTH_PROVIDER.GOOGLE, remember)
}

async function getMsalInstance() {
  if (!msalInstancePromise) {
    msalInstancePromise = import('@azure/msal-browser').then(async ({ PublicClientApplication }) => {
      const instance = new PublicClientApplication({
        auth: {
          clientId: microsoftClientId,
          authority: `https://login.microsoftonline.com/${microsoftTenantId}`,
          redirectUri: `${window.location.origin}/auth-redirect.html`,
        },
        cache: { cacheLocation: 'sessionStorage' },
      })
      await instance.initialize()
      return instance
    })
  }
  return msalInstancePromise
}

export async function signInWithMicrosoft(remember) {
  if (!providerConfigured[AUTH_PROVIDER.MICROSOFT]) {
    throw new Error('Microsoft sign-in is not configured. Add VITE_MICROSOFT_CLIENT_ID to .env.local and restart the dev server.')
  }

  const msal = await getMsalInstance()
  let result
  try {
    result = await msal.loginPopup({
      scopes: ['openid', 'profile', 'email', 'User.Read'],
      prompt: 'select_account',
    })
  } catch (error) {
    if (error?.errorCode === 'user_cancelled') {
      throw new Error('The Microsoft sign-in window was closed before finishing.', { cause: error })
    }
    throw new Error(error?.errorMessage || 'Microsoft sign-in was not completed.', { cause: error })
  }

  const { account } = result
  return createSession({
    name: account.name || account.username,
    email: account.username,
    homeAccountId: account.homeAccountId,
  }, AUTH_PROVIDER.MICROSOFT, remember)
}

export async function signOut(session) {
  clearStoredSession()

  if (session?.provider === AUTH_PROVIDER.GOOGLE && googleAccessToken) {
    window.google?.accounts?.oauth2?.revoke(googleAccessToken)
    googleAccessToken = null
  }

  if (session?.provider === AUTH_PROVIDER.MICROSOFT && providerConfigured[AUTH_PROVIDER.MICROSOFT]) {
    try {
      const msal = await getMsalInstance()
      const account = msal.getAccount({ homeAccountId: session.user.homeAccountId })
      await msal.clearCache({ account })
    } catch {
      // The local session is already cleared, which is what signs the user out here.
    }
  }
}

import TouchIcon from './TouchIcon.jsx'
import { useState } from 'react'
import {
  AUTH_PROVIDER,
  DEMO_CREDENTIALS,
  signInWithEmail,
  signInWithGoogle,
  signInWithMicrosoft,
} from './auth/authService.js'
import './LoginPage.css'

function LoginPage({ onSignIn, notice }) {
  const [email, setEmail] = useState(DEMO_CREDENTIALS.email)
  const [password, setPassword] = useState(DEMO_CREDENTIALS.password)
  const [showPassword, setShowPassword] = useState(false)
  const remember = true
  const [pending, setPending] = useState(null)
  const [error, setError] = useState('')

  const runSignIn = async (provider, signIn) => {
    setPending(provider)
    setError('')
    try {
      onSignIn(await signIn())
    } catch (signInError) {
      setError(signInError.message)
      setPending(null)
    }
  }

  const submitEmail = (event) => {
    event.preventDefault()
    runSignIn(AUTH_PROVIDER.EMAIL, () => signInWithEmail(email, password, remember))
  }

  const busy = pending !== null

  return <div className="touchscreen login-touch">
    <header className="touch-login-header"><a className="brand" href="#main"><span className="touch-logo"><TouchIcon /></span>ReturnScan</a><span>Station prototype</span></header>
    <main id="main" className="touch-main touch-login-grid"><section><h1>Sign in to your station</h1><p className="touch-subtitle">Use a demo account to explore ReturnScan.</p>
      {notice && <p role="status">{notice}</p>}
      <form className="touch-login-form" onSubmit={submitEmail}>
        <label>Email<input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} disabled={busy} required /></label>
        <label>Password<span className="touch-password"><input type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} required /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}><TouchIcon name="eye" /></button></span></label>
        {error && <p className="touch-error" role="alert">{error}</p>}
        <button className="touch-primary" disabled={busy}>{busy ? 'Signing in…' : '→ Sign in'}</button>
      </form><p className="password-note">Do not share your password with others.</p>
    </section><section className="touch-providers"><strong>Other sign-in options</strong><button className="touch-secondary" disabled={busy} onClick={() => runSignIn(AUTH_PROVIDER.GOOGLE, () => signInWithGoogle(remember))}><b>G</b> Google</button><button className="touch-secondary" disabled={busy} onClick={() => runSignIn(AUTH_PROVIDER.MICROSOFT, () => signInWithMicrosoft(remember))}><b>⊞</b> Microsoft</button></section></main>
    <footer className="touch-footer"><span>Demo station · No live email authentication</span><span>ReturnScan / Station 01</span></footer>
  </div>
}

export default LoginPage

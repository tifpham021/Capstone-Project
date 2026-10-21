import { useState } from 'react'
import logoPlate from './assets/figma/2b7d2.svg'
import logoMark from './assets/figma/733b6.svg'
import checkPlate from './assets/figma/56d09.svg'
import checkMark from './assets/figma/012f0.svg'
import shieldPlate from './assets/figma/cbe13.svg'
import shieldIcon from './assets/figma/d88f6.svg'
import shieldCheck from './assets/figma/70c7b.svg'
import pageBackground from './assets/figma/24aa6.svg'
import {
  AUTH_PROVIDER,
  DEMO_CREDENTIALS,
  providerConfigured,
  signInWithEmail,
  signInWithGoogle,
  signInWithMicrosoft,
} from './auth/authService.js'
import './LoginPage.css'

const highlights = [
  'Scan, inspect, and decide in one guided workflow',
  'Every decision is tied to your reviewer account',
  'Evidence is preserved in the case audit log',
]

function GoogleLogo() {
  return (
    <svg className="provider-logo" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  )
}

function MicrosoftLogo() {
  return (
    <svg className="provider-logo" viewBox="0 0 23 23" aria-hidden="true">
      <path fill="#f25022" d="M1 1h10v10H1z" />
      <path fill="#7fba00" d="M12 1h10v10H12z" />
      <path fill="#00a4ef" d="M1 12h10v10H1z" />
      <path fill="#ffb900" d="M12 12h10v10H12z" />
    </svg>
  )
}

function LoginPage({ onSignIn, notice }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(true)
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

  const fillDemo = () => {
    setEmail(DEMO_CREDENTIALS.email)
    setPassword(DEMO_CREDENTIALS.password)
    setError('')
  }

  const busy = pending !== null

  return (
    <div className="login-shell" style={{ backgroundImage: `url(${pageBackground})` }}>
      <main className="login-layout">
        <section className="login-brand-panel" aria-label="About ReturnScan">
          <div className="login-brand">
            <span className="layered-icon brand-icon">
              <img src={logoPlate} alt="" />
              <img src={logoMark} alt="" />
            </span>
            <span>ReturnScan</span>
          </div>
          <div className="login-brand-copy">
            <h2>Verified returns, reviewed by people.</h2>
            <p>Sign in to identify returned items, compare them against the original shipment, and record a final decision.</p>
          </div>
          <ul className="login-highlights">
            {highlights.map((item) => (
              <li key={item}>
                <span className="layered-icon check">
                  <img src={checkPlate} alt="" />
                  <img src={checkMark} alt="" />
                </span>
                {item}
              </li>
            ))}
          </ul>
          <div className="login-evidence">
            <span className="layered-icon shield">
              <img src={shieldPlate} alt="" />
              <img src={shieldIcon} alt="" />
              <img src={shieldCheck} alt="" />
            </span>
            <p>Automated signals are advisory. The final decision always belongs to the signed-in reviewer.</p>
          </div>
        </section>

        <section className="login-card" aria-labelledby="login-title">
          <div className="login-card-header">
            <h1 id="login-title">Sign in to ReturnScan</h1>
            <p>Use your work account to continue to the return station.</p>
          </div>

          {notice ? <div className="login-notice" role="status">{notice}</div> : null}

          <div className="provider-buttons">
            <button
              type="button"
              className="provider-button"
              disabled={busy}
              onClick={() => runSignIn(AUTH_PROVIDER.GOOGLE, () => signInWithGoogle(remember))}
            >
              <GoogleLogo />
              {pending === AUTH_PROVIDER.GOOGLE ? 'Waiting for Google…' : 'Continue with Google'}
              {!providerConfigured[AUTH_PROVIDER.GOOGLE] ? <small>Setup needed</small> : null}
            </button>
            <button
              type="button"
              className="provider-button"
              disabled={busy}
              onClick={() => runSignIn(AUTH_PROVIDER.MICROSOFT, () => signInWithMicrosoft(remember))}
            >
              <MicrosoftLogo />
              {pending === AUTH_PROVIDER.MICROSOFT ? 'Waiting for Microsoft…' : 'Continue with Microsoft'}
              {!providerConfigured[AUTH_PROVIDER.MICROSOFT] ? <small>Setup needed</small> : null}
            </button>
          </div>

          <div className="divider login-divider"><span>Or sign in with email</span></div>

          <form className="login-form" onSubmit={submitEmail} noValidate>
            <label className="login-field">
              <span>Work email</span>
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@company.com"
                disabled={busy}
              />
            </label>
            <label className="login-field">
              <span>Password</span>
              <span className="password-input">
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter your password"
                  disabled={busy}
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </span>
            </label>

            <div className="login-options">
              <label className="remember-option">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                Keep me signed in on this device
              </label>
            </div>

            {error ? <p className="login-error" role="alert">{error}</p> : null}

            <button className="login-submit" type="submit" disabled={busy}>
              {pending === AUTH_PROVIDER.EMAIL ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="demo-credentials">
            <div>
              <strong>Demo account</strong>
              <small>{DEMO_CREDENTIALS.email} / {DEMO_CREDENTIALS.password}</small>
            </div>
            <button type="button" onClick={fillDemo} disabled={busy}>Use demo account</button>
          </div>
        </section>
      </main>
    </div>
  )
}

export default LoginPage

import React from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import { tenantConfig } from './config';
import './styles.css';

function buildCognitoUrl() {
  if (!tenantConfig.cognitoDomain || !tenantConfig.cognitoClientId) return '';
  const params = new URLSearchParams({
    client_id: tenantConfig.cognitoClientId,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: tenantConfig.cognitoRedirectUri,
  });
  const domain = tenantConfig.cognitoDomain.replace(/\/$/, '');
  return `${domain}/oauth2/authorize?${params.toString()}`;
}

function LandingPage() {
  return (
    <main className="landing-shell">
      <section className="landing-band" aria-label="Zenex Foundation Evidence Intelligence">
        <div className="landing-mark">
          <img src={tenantConfig.logoUrl} alt="Zenex Foundation" />
        </div>

        <div className="landing-copy">
          <h1>{tenantConfig.orgName} Evidence Intelligence</h1>
          <p>Thirty years of Foundation Phase evidence, classified and decision-ready.</p>
          <a className="primary-action" href="/login">
            <span>Sign In</span>
            <ArrowRight size={18} strokeWidth={2.4} />
          </a>
        </div>

        <div className="powered-line">Powered by Auxeira EvidenceOS</div>
      </section>
    </main>
  );
}

function LoginPage() {
  const cognitoUrl = buildCognitoUrl();

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-label="Zenex Foundation sign in">
        <div className="auth-identity">
          <img src={tenantConfig.logoUrl} alt="Zenex Foundation" />
          <div>
            <p className="eyebrow">EvidenceOS access</p>
            <h1>{tenantConfig.orgName}</h1>
          </div>
        </div>

        <div className="auth-copy">
          <h2>Sign in to Evidence Intelligence</h2>
          <p>Use your organisation email to continue through Zenex Foundation's secure Cognito sign-in.</p>
        </div>

        <div className="auth-fields" aria-hidden="true">
          <div className="auth-field">
            <Mail size={18} />
            <span>name@zenex.org.za</span>
          </div>
          <div className="auth-field">
            <LockKeyhole size={18} />
            <span>Password managed by Cognito</span>
          </div>
        </div>

        {cognitoUrl ? (
          <a className="primary-action auth-action" href={cognitoUrl}>
            <span>Continue Securely</span>
            <ArrowRight size={18} strokeWidth={2.4} />
          </a>
        ) : (
          <button className="primary-action auth-action" type="button" disabled>
            Cognito Hosted UI Not Configured
          </button>
        )}

        <div className="auth-note">
          <ShieldCheck size={16} />
          <span>Tokens are handled in memory after sign-in and are never stored in localStorage.</span>
        </div>
      </section>
    </main>
  );
}

function App() {
  if (window.location.pathname === '/login') return <LoginPage />;
  return <LandingPage />;
}

createRoot(document.getElementById('root')).render(<App />);

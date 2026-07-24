import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  FileText,
  Gauge,
  Layers3,
  LockKeyhole,
  Mail,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Users,
} from 'lucide-react';
import { tenantConfig } from './config';
import './styles.css';

const healthDimensions = [
  { label: 'Method rigour', score: 4.3 },
  { label: 'Data quality', score: 4.1 },
  { label: 'Transparency', score: 3.9 },
  { label: 'Replicability', score: 3.7 },
  { label: 'Policy relevance', score: 4.6 },
];

const cascadeStages = [
  {
    title: 'Financial Capital',
    value: 'R84.2m',
    detail: 'Programme investment represented in classified evidence.',
  },
  {
    title: 'Evidence Capital',
    value: '5 records',
    detail: 'Evaluation assets extracted, classified, and quality scored.',
  },
  {
    title: 'Decision Capital',
    value: '3 briefs',
    detail: 'Audience-ready knowledge products queued for leadership use.',
  },
  {
    title: 'Institutional Capital',
    value: '2 reviews',
    detail: 'Expert review items strengthening the evidence base.',
  },
];

const workQueue = [
  { title: 'Foundation Phase reading synthesis', owner: 'Evidence Analyst', state: 'Review' },
  { title: 'Learner outcome dashboard brief', owner: 'Communications', state: 'Draft' },
  { title: 'Quarterly trustee evidence pack', owner: 'Organisation Lead', state: 'Ready' },
];

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

function DashboardPage() {
  const evidenceHealthScore = 82;

  return (
    <main className="dashboard-shell">
      <aside className="dashboard-sidebar" aria-label="EvidenceOS navigation">
        <div className="sidebar-brand">
          <img src={tenantConfig.logoUrl} alt="Zenex Foundation" />
          <span>EvidenceOS</span>
        </div>

        <nav className="sidebar-nav">
          <a className="active" href="/dashboard">
            <Gauge size={18} />
            <span>Dashboard</span>
          </a>
          <a href="/dashboard">
            <FileText size={18} />
            <span>Library</span>
          </a>
          <a href="/dashboard">
            <UploadCloud size={18} />
            <span>Upload</span>
          </a>
          <a href="/dashboard">
            <Sparkles size={18} />
            <span>Products</span>
          </a>
          <a href="/dashboard">
            <Users size={18} />
            <span>Users</span>
          </a>
        </nav>
      </aside>

      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Zenex Foundation</p>
            <h1>Evidence Health Dashboard</h1>
          </div>
          <div className="tenant-pill">
            <ShieldCheck size={16} />
            <span>Tenant: {tenantConfig.tenant}</span>
          </div>
        </header>

        <section className="dashboard-grid" aria-label="Evidence health summary">
          <article className="health-panel">
            <div className="panel-title">
              <Gauge size={20} />
              <span>Evidence Health Score</span>
            </div>
            <div className="score-row">
              <strong>{evidenceHealthScore}</strong>
              <span>/100</span>
            </div>
            <div className="score-track" aria-hidden="true">
              <span style={{ width: `${evidenceHealthScore}%` }} />
            </div>
            <p>Overall portfolio readiness based on rigour, data quality, transparency, replicability, and policy relevance.</p>
          </article>

          <article className="dimension-panel">
            <div className="panel-title">
              <BarChart3 size={20} />
              <span>Quality Dimensions</span>
            </div>
            <div className="dimension-list">
              {healthDimensions.map((item) => (
                <div className="dimension-row" key={item.label}>
                  <span>{item.label}</span>
                  <div className="mini-track" aria-hidden="true">
                    <span style={{ width: `${(item.score / 5) * 100}%` }} />
                  </div>
                  <strong>{item.score.toFixed(1)}</strong>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="cascade-section" aria-label="Three-Capital cascade">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Three-Capital cascade</p>
              <h2>From spend to institutional learning</h2>
            </div>
            <Layers3 size={24} />
          </div>

          <div className="cascade-grid">
            {cascadeStages.map((stage, index) => (
              <article className="cascade-card" key={stage.title}>
                <div className="cascade-index">{String(index + 1).padStart(2, '0')}</div>
                <h3>{stage.title}</h3>
                <strong>{stage.value}</strong>
                <p>{stage.detail}</p>
                {index < cascadeStages.length - 1 && <ArrowRight className="cascade-arrow" size={18} />}
              </article>
            ))}
          </div>
        </section>

        <section className="work-section" aria-label="Evidence work queue">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Operational queue</p>
              <h2>Next evidence actions</h2>
            </div>
          </div>

          <div className="queue-list">
            {workQueue.map((item) => (
              <article className="queue-item" key={item.title}>
                <CheckCircle2 size={18} />
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.owner}</p>
                </div>
                <span>{item.state}</span>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

function App() {
  if (window.location.pathname === '/login') return <LoginPage />;
  if (window.location.pathname === '/dashboard') return <DashboardPage />;
  return <LandingPage />;
}

createRoot(document.getElementById('root')).render(<App />);

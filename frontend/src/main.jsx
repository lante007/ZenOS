import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Check,
  CheckCircle2,
  ClipboardCopy,
  Clock3,
  Database,
  Download,
  Edit3,
  Filter,
  FileCheck2,
  FileText,
  Gauge,
  Layers,
  KeyRound,
  Layers3,
  LockKeyhole,
  Mail,
  Search,
  ShieldCheck,
  TrendingUp,
  UploadCloud,
  Users,
  X,
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
    // Source: Zenex board-approved budget 2019-2025. Pending audited confirmation.
    value: 'R428m',
    detail: 'Board-approved portfolio investment 2019-2025 · pending financial records.',
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

const FALLBACK_QUEUE_EMPTY = [];

const knowledgeAudiences = [
  { id: 'TRUSTEE', label: 'Trustee', focus: 'Governance, risk, and portfolio value' },
  { id: 'CEO', label: 'CEO', focus: 'Strategic decisions and institutional learning' },
  { id: 'DBE_NATIONAL', label: 'DBE National', focus: 'Policy alignment and scalable implications' },
  { id: 'PROVINCIAL_HOD', label: 'Provincial HOD', focus: 'Implementation action and district relevance' },
  { id: 'CO_FUNDER', label: 'Co-Funder', focus: 'Investment rationale and evidence confidence' },
  { id: 'SECTOR_PEER', label: 'Sector Peer', focus: 'Practice learning and replication conditions' },
];

const pipelineSteps = [
  'Secure upload to tenant S3 bucket',
  'Extract text from source document',
  'Detect programme and document metadata',
  'Classify and score document',
  'Apply quality standards',
  'Calculate Evidence Quality Score',
  'Create expert queue items',
  'Save record and publish to library',
];

const adeiFieldLabels = [
  ['adei_record_id', 'ADEI Record ID'],
  ['tenant_id', 'Tenant ID'],
  ['filename', 'Filename'],
  ['source_uri', 'Source URI'],
  ['institution', 'Institution'],
  ['programme_name', 'Programme Name'],
  ['document_type', 'Document Type'],
  ['publication_year', 'Publication Year'],
  ['classification_date', 'Classification Date'],
  ['evaluation_design', 'Evaluation Design'],
  ['methodology', 'Methodology'],
  ['sample_size', 'Sample Size'],
  ['unit_of_analysis', 'Unit of Analysis'],
  ['province', 'Province'],
  ['district', 'District'],
  ['phase', 'Phase'],
  ['grade', 'Grade'],
  ['subject_area', 'Subject Area'],
  ['intervention_type', 'Intervention Type'],
  ['implementation_period', 'Implementation Period'],
  ['population_served', 'Population Served'],
  ['comparison_group', 'Comparison Group'],
  ['data_sources', 'Data Sources'],
  ['baseline_available', 'Baseline Available'],
  ['endline_available', 'Endline Available'],
  ['key_finding_1', 'Key Finding 1'],
  ['key_finding_2', 'Key Finding 2'],
  ['key_finding_3', 'Key Finding 3'],
  ['null_findings', 'Null Findings'],
  ['non_significant_variables', 'Non-Significant Variables'],
  ['effect_direction', 'Effect Direction'],
  ['effect_size', 'Effect Size'],
  ['cost_data_source', 'Cost Data Source'],
  ['audited_financials_used', 'Audited Financials Used'],
  ['sroi_ready', 'SROI Ready'],
  ['policy_alignment', 'Policy Alignment'],
  ['decision_relevance', 'Decision Relevance'],
  ['assumption_challenge', 'Assumption Challenge'],
  ['evidence_gap', 'Evidence Gap'],
  ['replication_conditions', 'Replication Conditions'],
  ['limitations', 'Limitations'],
  ['equity_considerations', 'Equity Considerations'],
  ['data_quality_score', 'Data Quality Score'],
  ['rigour_score', 'Rigour Score'],
  ['transparency_score', 'Transparency Score'],
  ['replicability_score', 'Replicability Score'],
  ['policy_relevance_score', 'Policy Relevance Score'],
  ['eqs_composite', 'EQS Composite'],
  ['eqs_tier', 'EQS Tier'],
  ['confidence_tier', 'Confidence Tier'],
  ['board_citable', 'Board Citable'],
  ['evidence_capital_score', 'Evidence Capital Score'],
  ['half_life_rating', 'Half-Life Rating'],
  ['audience_relevance', 'Audience Relevance'],
  ['expert_review_required', 'Expert Review Required'],
];

const FALLBACK_RECORDS_EMPTY = [];

const API_BASE = tenantConfig.apiUrl.replace(/\/$/, '');
const ID_TOKEN_STORAGE_KEY = 'evidenceos_id_token';
const ACCESS_TOKEN_STORAGE_KEY = 'evidenceos_access_token';
let browserIdToken = sessionStorage.getItem(ID_TOKEN_STORAGE_KEY) || '';
let browserAccessToken = sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || '';

function currentUser() {
  const payload = decodeJwtPayload(browserIdToken);
  return {
    ...payload,
    role: payload['custom:role'] || payload['custom:custom:role'] || payload.role || 'ORGANISATION_LEAD',
    given_name: payload.given_name,
    name: payload.name || [payload.given_name, payload.family_name].filter(Boolean).join(' '),
    email: payload.email,
    preferred_username: payload.preferred_username,
    cognito_username: payload['cognito:username'],
  };
}

function consumeIdTokenFromHash() {
  if (!window.location.hash.includes('id_token=')) return '';
  const params = new URLSearchParams(window.location.hash.slice(1));
  browserIdToken = params.get('id_token') || '';
  browserAccessToken = params.get('access_token') || '';
  if (browserIdToken) sessionStorage.setItem(ID_TOKEN_STORAGE_KEY, browserIdToken);
  if (browserAccessToken) sessionStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, browserAccessToken);
  window.history.replaceState(null, '', window.location.pathname);
  return browserIdToken;
}

consumeIdTokenFromHash();

function setInMemoryToken(idToken, accessToken = '') {
  browserIdToken = idToken || '';
  browserAccessToken = accessToken || '';
  if (browserIdToken) sessionStorage.setItem(ID_TOKEN_STORAGE_KEY, browserIdToken);
  else sessionStorage.removeItem(ID_TOKEN_STORAGE_KEY);
  if (browserAccessToken) sessionStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, browserAccessToken);
  else sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
}

function decodeJwtPayload(token) {
  if (!token) return {};
  try {
    const payload = token.split('.')[1] || '';
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

function routeForAuthToken(token) {
  const payload = decodeJwtPayload(token);
  const role = payload['custom:role'] || payload['custom:custom:role'] || payload.role || 'ORGANISATION_LEAD';
  if (role === 'CEO_EXEC') return '/exec';
  if (role === 'COMMUNICATIONS') return '/products';
  if (role === 'EVIDENCE_ANALYST') return '/records';
  return '/dashboard';
}

function formatDisplayDate(value = new Date(), options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return date.toLocaleDateString('en-GB', {
    weekday: options.weekday,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatRecordValue(value, suffix = '') {
  if (value == null || value === '') return 'Not recorded';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'Not recorded';
  return `${value}${suffix}`;
}

function formatScore(value) {
  return value == null || value === '' ? 'Not recorded' : `${value}/5`;
}

function recordId(record) {
  return record?.adei_record_id || record?.id;
}

function greetingNameFor(user) {
  const value = user?.given_name
    || user?.name?.split(' ')[0]
    || user?.email?.split('@')[0]
    || user?.['cognito:username']
    || user?.cognito_username
    || user?.preferred_username;
  return value || '';
}

function dateTimeStamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function navigateInApp(path) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new Event('evidenceos:navigate'));
}

const navigate = navigateInApp;

async function apiRequest(path, options = {}) {
  const user = currentUser();
  const token = browserIdToken || sessionStorage.getItem(ID_TOKEN_STORAGE_KEY) || browserAccessToken || sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
  const headers = {
    'x-evidenceos-tenant': options.tenant || tenantConfig.tenant,
    'x-evidenceos-role': options.role || user.role || 'ORGANISATION_LEAD',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.user ? { 'x-evidenceos-user': options.user } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  return response.json();
}

function normalizeRecord(record) {
  const tier = record.eqs_tier || record.confidence_tier || 'Tier 2';
  return {
    ...record,
    adei_record_id: record.adei_record_id || record.id || `ADEI-${record.filename || 'record'}`,
    tenant_id: record.tenant_id || tenantConfig.tenant,
    filename: record.filename || record.name || 'Untitled evidence record',
    source_uri: record.source_uri || record.s3_key || 'S3 source pending',
    institution: record.institution || tenantConfig.orgName,
    programme_name: record.programme_name || record.programme || 'Unassigned programme',
    document_type: record.document_type || 'Evaluation Report',
    publication_year: record.publication_year || record.year || 'Not recorded',
    classification_date: record.classification_date || record.classified_at || 'Not recorded',
    province: record.province || (Array.isArray(record.provinces) ? record.provinces.join(', ') : record.provinces) || 'Not recorded',
    phase: record.phase || 'Not recorded',
    eqs_tier: String(tier).replace('TIER_', 'Tier '),
    confidence_tier: record.confidence_tier || tier,
    eqs_composite: record.eqs_composite || record.evidence_capital_score || 'N/A',
    key_finding_1: record.key_finding_1 || 'No primary finding captured.',
    key_finding_2: record.key_finding_2 || 'No secondary finding captured.',
    key_finding_3: record.key_finding_3 || 'No tertiary finding captured.',
  };
}

function fullRecordFields(record) {
  const evaluationDesign = [record.evaluation_subtype, record.evaluation_design].filter(Boolean).join(' · ');
  const sampleSize = [
    record.sample_size_learners ? `${record.sample_size_learners} learners` : null,
    record.sample_size_schools ? `${record.sample_size_schools} schools` : null,
  ].filter(Boolean).join(' · ');
  return [
    ['CLASSIFICATION DATE', formatDisplayDate(record.classified_at || record.classification_date)],
    ['DOCUMENT YEAR', record.year || record.publication_year],
    ['EVALUATION DESIGN', evaluationDesign],
    ['METHODOLOGY', record.methodology_description || record.methodology],
    ['SAMPLE SIZE', sampleSize],
    ['UNIT OF ANALYSIS', record.unit_of_analysis],
    ['GRADE', record.grade],
    ['SUBJECT AREA', record.subject_area],
    ['INTERVENTION TYPE', record.intervention_type],
    ['POPULATION SERVED', record.population_served],
    ['COMPARISON GROUP', record.comparison_group],
    ['BASELINE AVAILABLE', record.baseline_available],
    ['ENDLINE AVAILABLE', record.endline_available],
    ['NULL FINDINGS REPORTED', record.null_findings_reported],
    ['NON-SIGNIFICANT VARIABLES', record.non_significant_variables],
    ['EFFECT DIRECTION', record.effect_direction],
    ['EFFECT SIZE', record.effect_size_composite == null ? null : `${record.effect_size_composite} SD`],
    ['COST DATA SOURCE', record.cost_data_source],
    ['AUDITED FINANCIALS', record.audited_financials_used],
    ['SROI READY', record.sroi_ready],
    ['POLICY ALIGNMENT', record.policy_alignment],
    ['DECISION RELEVANCE', record.decision_relevance],
    ['REPLICATION CONDITIONS', record.replication_conditions],
    ['LIMITATIONS', record.limitations],
    ['EQUITY CONSIDERATIONS', record.equity_considerations],
    ['COMMISSIONED BY', record.commissioning_organisation_type],
    ['IMPLEMENTED BY', record.implementing_organisation_name],
    ['RIGOUR SCORE', formatScore(record.dim_methodological_rigour || record.rigour_score)],
    ['DATA QUALITY SCORE', formatScore(record.dim_data_quality || record.data_quality_score)],
    ['TRANSPARENCY SCORE', formatScore(record.dim_transparency || record.transparency_score)],
    ['REPLICABILITY SCORE', formatScore(record.dim_replicability || record.replicability_score)],
    ['POLICY RELEVANCE SCORE', formatScore(record.policy_relevance_score)],
  ];
}

function RecordDetailModal({ record, onClose }) {
  if (!record) return null;
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="record-modal" role="dialog" aria-modal="true" aria-label="ADEI record detail" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">ADEI 55-field detail</p>
            <h2>{record.programme_name}</h2>
            <p>{record.filename}</p>
          </div>
          <button className="icon-button" type="button" aria-label="Close record detail" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="field-grid">
          {fullRecordFields(record).map(([label, value]) => (
            <div className="field-cell" key={label}>
              <span>{label}</span>
              <strong>{formatRecordValue(value)}</strong>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function normalizeQueueItem(item) {
  const rawConfidence = Number(item.claude_confidence ?? item.confidence ?? 0);
  const confidence = rawConfidence > 1 ? rawConfidence / 100 : rawConfidence;
  return {
    id: item.id,
    recordId: item.record_id || item.id,
    programmeName: item.programme_name || item.record?.programme_name || item.document || item.record || item.record_id || 'Evidence record',
    fieldName: item.field_name || item.field || 'classification_field',
    recommendation: item.system_recommendation || item.recommendation || item.claude_value || 'Review required',
    confidence,
    targetRole: item.target_role || item.assigned_role || item.role || 'ORGANISATION_LEAD',
    state: item.resolved_at || item.status === 'RESOLVED' ? 'Resolved' : 'Pending review',
    alternatives: item.alternatives || ['Confirm recommendation', 'Override manually', 'Defer review'],
    rationale: item.question || item.rationale || 'Low-confidence classification requires Organisation Lead review.',
  };
}

function formatQueueConfidence(confidence) {
  return `${Math.round(Number(confidence || 0) * 100)}% confidence`;
}

function useLiveRecords() {
  const [records, setRecords] = useState(FALLBACK_RECORDS_EMPTY);
  const [source, setSource] = useState('live');

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/records')
      .then(data => {
        if (!cancelled && Array.isArray(data)) {
          setRecords(data.map(normalizeRecord));
          setSource('live');
        }
      })
      .catch(() => {
        if (!cancelled) setSource('offline');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { records, source };
}

function useAlerts() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(false);

  async function loadAlerts() {
    setLoading(true);
    try {
      const data = await apiRequest('/api/alerts');
      setAlerts(Array.isArray(data) ? data : []);
    } catch {
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAlerts();
  }, []);

  async function markRead(id) {
    setAlerts(current => current.filter(alert => alert.id !== id));
    try {
      await apiRequest(`/api/alerts/${id}/read`, { method: 'POST' });
    } catch {
      await loadAlerts();
    }
  }

  return { alerts, loading, loadAlerts, markRead };
}

const alertIcons = {
  AUDIENCE_GAP: '📋',
  CURRENCY_ALERT: '⏱',
  COMMISSIONING_GAP: '💡',
  QUEUE_BACKLOG: '⚠️',
  BOARD_PROXIMITY: '📅',
  ENDLINE_GAP: '🔍',
  POLICY_WINDOW: '📢',
};

async function cognitoRequest(target, body) {
  const response = await fetch(`https://cognito-idp.${tenantConfig.cognitoRegion}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.__type || 'Cognito request failed');
  }
  return payload;
}

async function signOutOfCognito() {
  const accessToken = browserAccessToken || sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
  if (accessToken) {
    await cognitoRequest('GlobalSignOut', {
      AccessToken: accessToken,
    });
  }
  setInMemoryToken('', '');
}

async function signInWithClient(clientId, email, password) {
  if (!clientId) throw new Error('Cognito app client is not configured');
  return cognitoRequest('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password,
    },
  });
}

async function signInWithCognito(email, password) {
  return signInWithClient(tenantConfig.cognitoClientId, email, password);
}

async function completeNewPasswordChallengeForClient(clientId, username, newPassword, session) {
  if (!clientId) throw new Error('Cognito app client is not configured');
  return cognitoRequest('RespondToAuthChallenge', {
    ClientId: clientId,
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    Session: session,
    ChallengeResponses: {
      USERNAME: username,
      NEW_PASSWORD: newPassword,
    },
  });
}

async function completeNewPasswordChallenge(username, newPassword, session) {
  return completeNewPasswordChallengeForClient(tenantConfig.cognitoClientId, username, newPassword, session);
}

async function logLoginEvent(idToken) {
  if (!idToken) return;
  await fetch(`${API_BASE}/api/audit/login`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'x-evidenceos-tenant': tenantConfig.tenant,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'user_login' }),
  }).catch(() => {});
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
          <div className="landing-actions">
            <a className="primary-action" href="/login">
              <span>Sign In</span>
              <ArrowRight size={18} strokeWidth={2.4} />
            </a>
            <a className="request-access-link" href="mailto:hello@auxeira.com?subject=EvidenceOS%20Access%20Request%20-%20Zenex%20Foundation">
              Request Access
            </a>
          </div>
        </div>

        <div className="powered-line">Powered by Auxeira EvidenceOS</div>
      </section>
    </main>
  );
}

function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const username = email.trim();
      const result = await signInWithCognito(username, password);
      if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        sessionStorage.setItem('evidenceos_new_password_session', result.Session);
        sessionStorage.setItem('evidenceos_new_password_username', username);
        navigateInApp('/change-password');
        return;
      }
      const idToken = result.AuthenticationResult?.IdToken || '';
      setInMemoryToken(idToken, result.AuthenticationResult?.AccessToken || '');
      await logLoginEvent(idToken);
      navigateInApp(routeForAuthToken(idToken));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

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
          <p>Use your organisation email and password to access Zenex Foundation's secure EvidenceOS space.</p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            <span>Email</span>
            <div className="auth-input">
              <Mail size={18} />
              <input value={email} onChange={event => setEmail(event.target.value)} type="email" placeholder="name@zenexfoundation.org.za" required />
            </div>
          </label>
          <label>
            <span>Password</span>
            <div className="auth-input">
              <LockKeyhole size={18} />
              <input value={password} onChange={event => setPassword(event.target.value)} type="password" placeholder="Password" required />
            </div>
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-action auth-action" type="submit" disabled={busy || !tenantConfig.cognitoClientId}>
            <span>{busy ? 'Signing In' : 'Sign In'}</span>
            <ArrowRight size={18} strokeWidth={2.4} />
          </button>
        </form>
      </section>
    </main>
  );
}

function ChangePasswordPage() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const username = sessionStorage.getItem('evidenceos_new_password_username') || '';
  const session = sessionStorage.getItem('evidenceos_new_password_session') || '';
  const challengeClient = sessionStorage.getItem('evidenceos_new_password_client') || 'zenex';

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      const clientId = challengeClient === 'admin' ? tenantConfig.adminCognitoClientId : tenantConfig.cognitoClientId;
      const result = await completeNewPasswordChallengeForClient(clientId, username, password, session);
      const idToken = result.AuthenticationResult?.IdToken || '';
      setInMemoryToken(idToken, result.AuthenticationResult?.AccessToken || '');
      await logLoginEvent(idToken);
      sessionStorage.removeItem('evidenceos_new_password_username');
      sessionStorage.removeItem('evidenceos_new_password_session');
      sessionStorage.removeItem('evidenceos_new_password_client');
      navigateInApp(challengeClient === 'admin' ? '/admin/dashboard' : routeForAuthToken(idToken));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-label="Set EvidenceOS password">
        <div className="auth-identity">
          <img src={tenantConfig.logoUrl} alt="Zenex Foundation" />
          <div>
            <p className="eyebrow">First sign-in</p>
            <h1>Set your password</h1>
          </div>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            <span>New password</span>
            <div className="auth-input">
              <LockKeyhole size={18} />
              <input value={password} onChange={event => setPassword(event.target.value)} type="password" minLength={12} required />
            </div>
          </label>
          <label>
            <span>Confirm password</span>
            <div className="auth-input">
              <ShieldCheck size={18} />
              <input value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} type="password" minLength={12} required />
            </div>
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-action auth-action" type="submit" disabled={busy || !username || !session}>
            <span>{busy ? 'Saving' : 'Save Password'}</span>
            <ArrowRight size={18} strokeWidth={2.4} />
          </button>
        </form>
      </section>
    </main>
  );
}

function queueCount(queueItems = FALLBACK_QUEUE_EMPTY) {
  return queueItems.length;
}

function DashboardNav({ active, queueBadge = queueCount(), user = currentUser() }) {
  const canAsk = ['ORGANISATION_LEAD', 'EVIDENCE_ANALYST'].includes(user.role);
  const canSynthesise = ['ORGANISATION_LEAD', 'EVIDENCE_ANALYST'].includes(user.role);
  return (
    <>
      <aside className="dashboard-sidebar" aria-label="EvidenceOS navigation">
        <div className="sidebar-brand">
          <img src={tenantConfig.logoUrl} alt="Zenex Foundation" />
          <span>ZENEX FOUNDATION</span>
        </div>

        <nav className="sidebar-nav">
          <a className={active === 'dashboard' ? 'active' : ''} href="/dashboard">
            <Gauge size={18} />
            <span>Dashboard</span>
          </a>
          <a className={active === 'records' ? 'active' : ''} href="/records">
            <FileText size={18} />
            <span>Library</span>
          </a>
          <a className={active === 'classify' ? 'active' : ''} href="/classify">
            <UploadCloud size={18} />
            <span>Upload</span>
          </a>
          {canSynthesise && (
            <a className={active === 'synthesise' ? 'active' : ''} href="/synthesise">
              <Layers size={18} />
              <span>Synthesise</span>
            </a>
          )}
          {canAsk && (
            <a className={active === 'ask' ? 'active' : ''} href="/ask">
              <span className="nav-emoji" aria-hidden="true">🔍</span>
              <span>Ask Zenex</span>
            </a>
          )}
          <a className={active === 'knowledge' ? 'active' : ''} href="/products">
            <span className="nav-emoji" aria-hidden="true">📄</span>
            <span>Products</span>
          </a>
          <a className={active === 'queue' ? 'active' : ''} href="/queue">
            <CheckCircle2 size={18} />
            <span>Queue</span>
            <strong className="nav-badge">{queueBadge}</strong>
          </a>
          <a className={active === 'settings' ? 'active' : ''} href="/settings">
            <Users size={18} />
            <span>Settings</span>
          </a>
        </nav>
      </aside>
    </>
  );
}

function AppShell({ active, children, queueBadge }) {
  const user = currentUser();
  return (
    <main className="dashboard-shell">
      <DashboardNav active={active} queueBadge={queueBadge} user={user} />
      {children}
    </main>
  );
}

function DashboardPage() {
  const { records } = useLiveRecords();
  const [stats, setStats] = useState(null);
  const [queueItems, setQueueItems] = useState(FALLBACK_QUEUE_EMPTY);
  const [queueLoading, setQueueLoading] = useState(true);
  const user = currentUser();
  const { alerts, loading: alertsLoading, loadAlerts, markRead } = useAlerts();
  const [seedAttempted, setSeedAttempted] = useState(false);
  const hour = new Date().getHours();
  const greeting = hour < 12
    ? 'Good morning'
    : hour < 17
      ? 'Good afternoon'
      : 'Good evening';
  console.log('User object:', user);
  const firstName = greetingNameFor(user);
  const today = formatDisplayDate(new Date(), { weekday: 'long' });
  const evidenceHealthScore = stats?.records
    ? Math.round(((stats.tier_counts?.TIER_1 || stats.tier_counts?.['Tier 1'] || 0) / stats.records) * 100)
    : 82;

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/stats')
      .then(data => {
        if (!cancelled) setStats(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/queue')
      .then(data => {
        if (cancelled) return;
        setQueueItems(Array.isArray(data) ? data.map(normalizeQueueItem) : FALLBACK_QUEUE_EMPTY);
        setQueueLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setQueueItems(FALLBACK_QUEUE_EMPTY);
        setQueueLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (seedAttempted || alertsLoading || alerts.length > 0 || user.role !== 'ORGANISATION_LEAD') return;
    setSeedAttempted(true);
    apiRequest('/api/admin/flywheel/run', { method: 'POST' })
      .then(() => loadAlerts())
      .catch(() => {});
  }, [alerts.length, alertsLoading, loadAlerts, seedAttempted, user.role]);

  async function runIntelligenceCheck() {
    await apiRequest('/api/admin/flywheel/run', { method: 'POST' });
    await loadAlerts();
  }

  return (
    <AppShell active="dashboard" queueBadge={queueItems.length}>
      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Zenex Foundation</p>
            <h1>{firstName ? `${greeting}, ${firstName}` : greeting}</h1>
            <p>{today}</p>
          </div>
          <div className="header-actions">
            {user.role === 'ORGANISATION_LEAD' && (
              <button className="secondary-action" type="button" onClick={runIntelligenceCheck}>
                <Search size={17} />
                <span>Run intelligence check</span>
              </button>
            )}
            <div className="tenant-pill">
              <ShieldCheck size={16} />
              <span>Tenant: {tenantConfig.tenant}</span>
            </div>
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
                <strong>{stage.title === 'Evidence Capital' ? `${records.length} records` : stage.value}</strong>
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
            {queueLoading ? (
              <article className="queue-item">
                <Clock3 size={18} />
                <div>
                  <h3>Loading evidence actions...</h3>
                  <p>Checking the expert review queue</p>
                </div>
              </article>
            ) : queueItems.length === 0 ? (
              <article className="queue-item">
                <CheckCircle2 size={18} />
                <div>
                  <h3>No pending evidence actions.</h3>
                  <p>Evidence base is current.</p>
                </div>
              </article>
            ) : queueItems.map((item) => (
              <article className="queue-item" key={item.id}>
                <CheckCircle2 size={18} />
                <div>
                  <h3>{item.programmeName}</h3>
                  <p>
                    {item.fieldName} · {formatQueueConfidence(item.confidence)} · {roleLabel(item.targetRole)}
                    {item.recordId && ` · ${item.recordId}`}
                  </p>
                </div>
                <span>{item.state}</span>
              </article>
            ))}
          </div>
        </section>

        <section className="alerts-section" aria-label="Intelligence alerts">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Learning Flywheel</p>
              <h2>Intelligence Alerts</h2>
              <span>EvidenceOS surfaces the right intelligence to the right person at the right moment</span>
            </div>
            <span className="live-badge">Live</span>
          </div>

          {alerts.length === 0 ? (
            <article className="empty-panel compact">
              <CheckCircle2 size={24} />
              <p>No active alerts. Your evidence base is current.</p>
            </article>
          ) : (
            <div className="alert-grid">
              {alerts.map(alert => (
                <article className={`alert-card priority-${String(alert.priority || 'MEDIUM').toLowerCase()}`} key={alert.id}>
                  <div className="alert-icon" aria-hidden="true">{alertIcons[alert.alert_type] || '📢'}</div>
                  <div>
                    <h3>{alert.title}</h3>
                    <p>{alert.body}</p>
                    {alert.record_id && <a href={`/records?record=${alert.record_id}`}>Open record {alert.record_id}</a>}
                    <footer>
                      <span>{roleLabel(alert.target_role)}</span>
                      <span>{dateTimeStamp(alert.created_at)}</span>
                    </footer>
                  </div>
                  <button className="secondary-action mark-read-action" type="button" onClick={() => markRead(alert.id)}>
                    Mark as read
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    </AppShell>
  );
}

function normalizeFilterValue(value) {
  return String(value || '').toLowerCase();
}

function exportRecordsCsv(records) {
  const headers = adeiFieldLabels.map(([field]) => field);
  const csvRows = [
    headers.join(','),
    ...records.map(record => headers.map(field => {
      const value = record[field] == null ? '' : String(record[field]);
      return `"${value.replace(/"/g, '""')}"`;
    }).join(',')),
  ];
  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `zenex-evidence-records-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function RecordsPage() {
  const { records, source } = useLiveRecords();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({ tier: 'all', type: 'all', phase: 'all', province: 'all' });
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);

  const filteredRecords = useMemo(() => {
    return records.filter((record) => {
      const haystack = [
        record.filename,
        record.programme_name,
        record.document_type,
        record.province,
        record.phase,
        record.key_finding_1,
      ].join(' ').toLowerCase();
      const matchesQuery = !query || haystack.includes(query.toLowerCase());
      const matchesTier = filters.tier === 'all' || record.eqs_tier === filters.tier;
      const matchesType = filters.type === 'all' || record.document_type === filters.type;
      const matchesPhase = filters.phase === 'all' || record.phase === filters.phase;
      const matchesProvince = filters.province === 'all' || record.province === filters.province;
      return matchesQuery && matchesTier && matchesType && matchesPhase && matchesProvince;
    });
  }, [records, query, filters]);

  const unique = (field) => [...new Set(records.map(record => record[field]).filter(Boolean))];
  const visibleIds = filteredRecords.map(record => record.id || record.adei_record_id).filter(Boolean);
  const selectedVisibleIds = visibleIds.filter(id => selectedIds.includes(id));
  const selectAllChecked = visibleIds.length > 0 && selectedVisibleIds.length === Math.min(10, visibleIds.length);

  const toggleSelect = (id) => {
    setSelectedIds(prev =>
      prev.includes(id)
        ? prev.filter(x => x !== id)
        : prev.length < 10
          ? [...prev, id]
          : prev
    );
  };

  const toggleSelectAll = () => {
    setSelectedIds(prev => {
      if (selectAllChecked) {
        return prev.filter(id => !visibleIds.includes(id));
      }
      const next = [...prev];
      for (const id of visibleIds) {
        if (next.length >= 10) break;
        if (!next.includes(id)) next.push(id);
      }
      return next;
    });
  };

  return (
    <AppShell active="records">
      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Evidence library</p>
            <h1>Classified Intelligence Records</h1>
          </div>
          <button className="secondary-action" type="button" onClick={() => exportRecordsCsv(filteredRecords)}>
            <Download size={17} />
            <span>Export CSV</span>
          </button>
        </header>

        <section className="records-toolbar" aria-label="Evidence library filters">
          <label className="search-box">
            <Search size={18} />
            <input
              type="search"
              placeholder="Search by programme, finding, filename"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div className="filter-grid">
            <label>
              <Filter size={15} />
              <select value={filters.tier} onChange={(event) => setFilters({ ...filters, tier: event.target.value })}>
                <option value="all">All tiers</option>
                {unique('eqs_tier').map(value => <option value={value} key={value}>{value}</option>)}
              </select>
            </label>
            <label>
              <select value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value })}>
                <option value="all">All types</option>
                {unique('document_type').map(value => <option value={value} key={value}>{value}</option>)}
              </select>
            </label>
            <label>
              <select value={filters.phase} onChange={(event) => setFilters({ ...filters, phase: event.target.value })}>
                <option value="all">All phases</option>
                {unique('phase').map(value => <option value={value} key={value}>{value}</option>)}
              </select>
            </label>
            <label>
              <select value={filters.province} onChange={(event) => setFilters({ ...filters, province: event.target.value })}>
                <option value="all">All provinces</option>
                {unique('province').map(value => <option value={value} key={value}>{value}</option>)}
              </select>
            </label>
          </div>
        </section>

        <section className="table-panel" aria-label="Classified evidence records">
          <div className="table-summary">
            <span>{filteredRecords.length} records</span>
            <span>{source === 'live' ? 'Live API' : 'Offline preview'} · 55-field ADEI taxonomy v2.1</span>
          </div>
          <div className="records-table" role="table">
            <div className="records-row records-head" role="row">
              <span>
                <input
                  type="checkbox"
                  checked={selectAllChecked}
                  onChange={toggleSelectAll}
                  aria-label="Select up to 10 visible records"
                />
              </span>
              <span>Record</span>
              <span>Type</span>
              <span>Phase</span>
              <span>Province</span>
              <span>Tier</span>
              <span>EQS</span>
            </div>
            {filteredRecords.map((record) => (
              <div className="records-row" role="row" key={record.adei_record_id} onClick={() => setSelectedRecord(record)}>
                <span onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(record.id || record.adei_record_id)}
                    onChange={() => toggleSelect(record.id || record.adei_record_id)}
                    aria-label={`Select ${record.programme_name}`}
                  />
                </span>
                <span>
                  <strong>{record.programme_name}</strong>
                  <small>{record.filename}</small>
                </span>
                <span>{record.document_type}</span>
                <span>{record.phase}</span>
                <span>{record.province}</span>
                <span><mark>{record.eqs_tier}</mark></span>
                <span>{record.eqs_composite}</span>
              </div>
            ))}
          </div>
        </section>

        <RecordDetailModal record={selectedRecord} onClose={() => setSelectedRecord(null)} />
        {selectedIds.length > 0 && (
          <div className="selection-action-bar">
            <span>{selectedIds.length} record{selectedIds.length !== 1 ? 's' : ''} selected</span>
            <button type="button" onClick={() => setSelectedIds([])}>
              Clear
            </button>
            <button
              type="button"
              disabled={selectedIds.length !== 1}
              onClick={() => navigate(`/synthesise?records=${selectedIds[0]}`)}
            >
              Analyse single
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => navigate(`/synthesise?records=${selectedIds.join(',')}`)}
            >
              Synthesise selected
            </button>
          </div>
        )}
      </section>
    </AppShell>
  );
}

const askPrompts = [
  'What do we know about coaching in Foundation Phase?',
  'Which programmes have the strongest evidence in rural schools?',
  'Where are our biggest evidence gaps?',
  'What should we commission next?',
];

function SynthesisePage() {
  const user = currentUser();
  const { records } = useLiveRecords();
  const canSynthesise = ['ORGANISATION_LEAD', 'EVIDENCE_ANALYST'].includes(user.role);
  const [selectedRecords, setSelectedRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [synthesis, setSynthesis] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ids = (params.get('records') || '').split(',').filter(Boolean).slice(0, 10);
    if (!ids.length) return;
    apiRequest('/api/records')
      .then(all => {
        if (Array.isArray(all)) {
          setSelectedRecords(all.map(normalizeRecord).filter(r => ids.includes(r.id) || ids.includes(r.adei_record_id)));
        }
      })
      .catch(() => {});
  }, []);

  if (!canSynthesise) {
    return (
      <AppShell active="synthesise">
        <section className="dashboard-main">
          <article className="empty-panel">
            <LockKeyhole size={28} />
            <h2>Synthesis is not available for this role</h2>
          </article>
        </section>
      </AppShell>
    );
  }

  const addableRecords = records.filter(record => !selectedRecords.some(selected => recordId(selected) === recordId(record))).slice(0, 12);

  const handleGenerate = async () => {
    if (selectedRecords.length === 0) return;
    setLoading(true);
    setSynthesis(null);
    setError(null);
    try {
      const data = await apiRequest('/api/strategic-synthesis/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          record_ids: selectedRecords.map(r => r.id || r.adei_record_id),
        }),
      });
      if (data.success) setSynthesis(data);
      else setError(data.error || 'Generation failed');
    } catch {
      setError('Unable to generate synthesis. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!synthesis?.synthesis_id) return;
    setSaving(true);
    try {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateBrief = () => {
    if (!synthesis?.synthesis_id) return;
    navigate(`/products?synthesis_id=${synthesis.synthesis_id}`);
  };

  return (
    <AppShell active="synthesise">
      <section className="dashboard-main synthesise-page">
        <header className="dashboard-header page-header">
          <div>
            <p className="eyebrow">Strategic synthesis</p>
            <h1>Strategic Synthesis</h1>
            <p className="page-subheader">Cross-document patterns · gap analysis · strategic leverage points</p>
          </div>
        </header>

        <section className="selected-records-panel">
          <div className="selected-records-chips">
            {selectedRecords.map(r => (
              <div key={recordId(r)} className="record-chip">
                <span className="chip-programme">{r.programme_name}</span>
                <span className="chip-tier">{r.eqs_tier} · EQS {r.eqs_composite}</span>
                <button
                  className="chip-remove"
                  type="button"
                  onClick={() => setSelectedRecords(prev => prev.filter(x => recordId(x) !== recordId(r)))}
                  aria-label={`Remove ${r.programme_name}`}
                >
                  x
                </button>
              </div>
            ))}
            {selectedRecords.length < 10 && (
              <div className="record-picker compact-picker">
                {addableRecords.slice(0, 4).map(record => (
                  <button type="button" key={recordId(record)} onClick={() => setSelectedRecords(prev => [...prev, record])}>
                    <strong>{record.programme_name}</strong>
                    <span>{record.eqs_tier} · EQS {record.eqs_composite}</span>
                  </button>
                ))}
                <button className="chip-add" type="button" onClick={() => navigate('/records')}>
                  + Add document
                </button>
              </div>
            )}
          </div>

          <button
            className="btn-primary btn-generate"
            type="button"
            disabled={selectedRecords.length === 0 || loading}
            onClick={handleGenerate}
          >
            {loading ? `Analysing ${selectedRecords.length} records...` : 'Generate Synthesis'}
          </button>
        </section>

        {error && <div className="synthesis-error">{error}</div>}

        {synthesis && (
          <section className="synthesis-results">
            <div className="synthesis-section">
              <h2>Key Findings</h2>
              <p className="section-meta">Confidence-rated across selected evaluations</p>
              {(synthesis.findings || []).map((f, i) => (
                <article key={`${f.finding}-${i}`} className="finding-card">
                  <div className="finding-header">
                    <span className={`confidence-badge ${String(f.confidence || '').toLowerCase()}`}>{f.confidence}</span>
                    <span className="study-type">{f.study_type}</span>
                    {f.corroborated && <span className="badge-corroborated">CORROBORATED</span>}
                    {f.contested && <span className="badge-contested">CONTESTED</span>}
                  </div>
                  <p className="finding-text">{f.finding}</p>
                  {f.contradiction_note && <div className="contradiction-note">{f.contradiction_note}</div>}
                  <div className="source-chips">
                    {(f.source_record_ids || []).map(id => (
                      <button key={id} type="button" className="source-chip" onClick={() => navigate(`/records?record=${id}`)}>
                        {id}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </div>

            <div className="synthesis-section">
              <h2>Evidence Gaps</h2>
              <p className="section-meta">What the selected evaluations did not measure</p>
              {(synthesis.evidence_gaps || []).map((g, i) => (
                <article key={`${g.gap}-${i}`} className="gap-card">
                  <div className="gap-header">
                    <span className={`urgency-badge ${String(g.urgency || '').toLowerCase()}`}>{g.urgency}</span>
                    {g.commissioning_opportunity && <span className="badge-commission">COMMISSIONING OPPORTUNITY</span>}
                  </div>
                  <p className="gap-text">{g.gap}</p>
                  {g.policy_relevance && <div className="policy-relevance-note">Policy context: {g.policy_relevance}</div>}
                </article>
              ))}
            </div>

            <div className="synthesis-section">
              <h2>Strategic Leverage Points</h2>
              <p className="section-meta">Recommended actions for {tenantConfig.orgName}</p>
              {(synthesis.leverage_points || []).map((l, i) => (
                <article key={`${l.action}-${i}`} className="leverage-card">
                  <div className="leverage-header">
                    <span className={`urgency-badge ${String(l.urgency || '').toLowerCase()}`}>{l.urgency}</span>
                  </div>
                  <p className="leverage-action">{l.action}</p>
                  <p className="leverage-rationale">{l.rationale}</p>
                  {l.expected_influence && <p className="leverage-influence">Expected influence: {l.expected_influence}</p>}
                </article>
              ))}
            </div>

            {(synthesis.cross_patterns || []).length > 0 && (
              <div className="synthesis-section">
                <h2>Cross-Document Patterns</h2>
                <p className="section-meta">Patterns identified across {synthesis.record_count} records</p>
                {synthesis.cross_patterns.map((p, i) => (
                  <article key={`${p.pattern}-${i}`} className="pattern-card">
                    <p className="pattern-text">{p.pattern}</p>
                    <div className="source-chips">
                      {(p.records_involved || []).map(id => <span key={id} className="source-chip">{id}</span>)}
                    </div>
                    {p.implication && <p className="pattern-implication">{p.implication}</p>}
                  </article>
                ))}
              </div>
            )}

            <div className="synthesis-actions">
              <button className="btn-secondary" type="button" onClick={handleSave} disabled={saving || saved}>
                {saved ? 'Saved' : saving ? 'Saving...' : 'Save Synthesis'}
              </button>
              <button className="btn-primary" type="button" onClick={handleGenerateBrief}>
                Generate Audience Brief →
              </button>
            </div>
          </section>
        )}
      </section>
    </AppShell>
  );
}

function AskZenexPage() {
  const { records } = useLiveRecords();
  const user = currentUser();
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const canAsk = ['ORGANISATION_LEAD', 'EVIDENCE_ANALYST'].includes(user.role);

  const supportingRecords = useMemo(() => {
    const ids = result?.supporting_record_ids || [];
    return ids
      .map(id => records.find(record => recordId(record) === id || record.id === id))
      .filter(Boolean);
  }, [records, result]);

  async function submitAsk(prompt = question) {
    const clean = String(prompt || '').trim();
    if (!clean || loading) return;
    setQuestion(clean);
    setLoading(true);
    setError(false);
    setResult(null);
    try {
      const data = await apiRequest('/api/synthesis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: clean }),
      });
      setResult(data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  if (!canAsk) {
    return (
      <AppShell active="ask">
        <section className="dashboard-main">
          <article className="empty-panel">
            <LockKeyhole size={28} />
            <h2>Ask Zenex is not available for this role</h2>
          </article>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell active="ask">
      <section className="dashboard-main ask-page">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Evidence synthesis</p>
            <h1>Ask Zenex</h1>
            <p>Search {records.length} classified intelligence records</p>
          </div>
        </header>

        {records.length < 5 && (
          <article className="empty-panel compact">
            <p>Ask Zenex works best with a full evidence corpus. The full Zenex archive will be available once batch classification completes.</p>
          </article>
        )}

        <section className="ask-search-panel">
          <label className="ask-input">
            <Search size={22} />
            <input
              value={question}
              onChange={event => setQuestion(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') submitAsk();
              }}
              placeholder="Ask anything about Zenex's evidence base..."
            />
          </label>
          <button className="primary-action" type="button" disabled={!question.trim() || loading} onClick={() => submitAsk()}>
            <span>Ask</span>
            <ArrowRight size={18} />
          </button>
        </section>

        {!result && !loading && !error && (
          <section className="prompt-chip-grid" aria-label="Example prompts">
            {askPrompts.map(prompt => (
              <button type="button" key={prompt} onClick={() => submitAsk(prompt)}>{prompt}</button>
            ))}
          </section>
        )}

        {loading && (
          <section className="ask-loading">
            <span className="pulse-dot" />
            <strong>Searching {records.length} records...</strong>
          </section>
        )}

        {error && (
          <article className="error-banner">Unable to search the corpus right now. Please try again in a moment.</article>
        )}

        {result && (
          <section className="ask-results">
            <span className={`confidence-badge ${String(result.confidence || 'LOW').toLowerCase()}`}>{result.confidence}</span>
            <article className="answer-card">
              <p>{result.answer}</p>
            </article>

            <section className="supporting-records">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Supporting records</p>
                  <h2>Based on {supportingRecords.length || result.supporting_record_ids?.length || 0} records</h2>
                </div>
              </div>
              <div className="admin-record-grid">
                {supportingRecords.map(record => (
                  <button className="support-record-card" type="button" key={recordId(record)} onClick={() => setSelectedRecord(record)}>
                    <strong>{record.programme_name}</strong>
                    <span>{record.eqs_tier} · {record.year || record.publication_year}</span>
                    <p>{record.key_finding_1}</p>
                  </button>
                ))}
              </div>
            </section>

            {result.contradictions && (
              <article className="contradiction-box">
                <strong>Contradictory evidence noted</strong>
                <p>{result.contradictions}</p>
              </article>
            )}

            <article className="recommended-action-box">
              <strong>Recommended action</strong>
              <p>{result.recommended_action}</p>
            </article>

            <footer className="ask-footer">
              Searched {result.records_searched} records · {dateTimeStamp(result.generated_at)}
            </footer>
          </section>
        )}

        <RecordDetailModal record={selectedRecord} onClose={() => setSelectedRecord(null)} />
      </section>
    </AppShell>
  );
}

function ClassifyPage() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [driveFileId, setDriveFileId] = useState('');
  const [activeStep, setActiveStep] = useState(-1);
  const [classificationResult, setClassificationResult] = useState('');

  async function startPipeline() {
    setActiveStep(0);
    setClassificationResult('');
    pipelineSteps.forEach((_, index) => {
      window.setTimeout(() => setActiveStep(index), index * 360);
    });

    if (selectedFile) {
      try {
        const form = new FormData();
        form.append('document', selectedFile);
        const result = await apiRequest('/api/classify/upload', {
          method: 'POST',
          body: form,
        });
        setClassificationResult(`Created ${result.record_id || result.filename}`);
      } catch (error) {
        setClassificationResult(`Local API upload failed: ${error.message}`);
      }
    } else if (driveFileId.trim()) {
      setClassificationResult('Drive file ID fallback is captured, but live classification now requires S3 upload.');
    }

    window.setTimeout(() => setActiveStep(pipelineSteps.length), pipelineSteps.length * 360);
  }

  function handleFile(file) {
    if (!file) return;
    setSelectedFile(file);
    setActiveStep(-1);
  }

  const isComplete = activeStep >= pipelineSteps.length;
  const canStart = selectedFile || driveFileId.trim();

  return (
    <AppShell active="classify">
      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Classify evidence</p>
            <h1>Upload Document</h1>
          </div>
          <div className="tenant-pill">
            <Database size={16} />
            <span>auxeira-evidenceos-{tenantConfig.tenant}/raw/documents</span>
          </div>
        </header>

        <section className="classify-grid">
          <article className="upload-panel">
            <div
              className="drop-zone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                handleFile(event.dataTransfer.files[0]);
              }}
            >
              <UploadCloud size={42} />
              <h2>Drop PDF, Word, or PowerPoint files here</h2>
              <p>Uploads are routed to the Zenex private S3 storage area before classification starts.</p>
              <label className="secondary-action file-picker">
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.ppt,.pptx"
                  onChange={(event) => handleFile(event.target.files[0])}
                />
                <FileText size={17} />
                <span>Choose File</span>
              </label>
            </div>

            <div className="selected-file">
              <FileCheck2 size={18} />
              <div>
                <strong>{selectedFile ? selectedFile.name : 'No document selected'}</strong>
                <span>{selectedFile ? `${Math.max(1, Math.round(selectedFile.size / 1024))} KB ready for upload` : 'Use drag-drop, file picker, or Drive fallback.'}</span>
              </div>
            </div>

            <div className="drive-fallback">
              <label htmlFor="drive-file-id">Drive file ID fallback</label>
              <div>
                <input
                  id="drive-file-id"
                  type="text"
                  placeholder="1AbCDEFgHijK..."
                  value={driveFileId}
                  onChange={(event) => {
                    setDriveFileId(event.target.value);
                    setActiveStep(-1);
                  }}
                />
                <span>Legacy intake only</span>
              </div>
            </div>

            <button className="primary-action classify-action" type="button" disabled={!canStart} onClick={startPipeline}>
              <span>{isComplete ? 'Classification Complete' : 'Start Classification'}</span>
              <ArrowRight size={18} />
            </button>
          </article>

          <article className="pipeline-panel">
            <div className="panel-title">
              <Clock3 size={20} />
              <span>8-step pipeline</span>
            </div>

            <div className="pipeline-list">
              {pipelineSteps.map((step, index) => {
                const complete = activeStep > index || isComplete;
                const active = activeStep === index && !isComplete;
                return (
                  <div className={`pipeline-step ${complete ? 'complete' : ''} ${active ? 'active' : ''}`} key={step}>
                    <div>{complete ? <CheckCircle2 size={16} /> : <span>{index + 1}</span>}</div>
                    <p>{step}</p>
                  </div>
                );
              })}
            </div>

            <div className="pipeline-result">
              <p className="eyebrow">Pipeline state</p>
              <strong>{isComplete ? 'Record ready for Evidence Library' : activeStep >= 0 ? 'Classification running' : 'Waiting for document'}</strong>
              <span>{classificationResult || (isComplete ? 'Expert queue and EQS outputs are prepared for review.' : 'Progress updates will stream here from the live API.')}</span>
            </div>
          </article>
        </section>
      </section>
    </AppShell>
  );
}

function QueuePage() {
  const [items, setItems] = useState(FALLBACK_QUEUE_EMPTY);
  const [overrideValues, setOverrideValues] = useState({});

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/queue')
      .then(data => {
        if (!cancelled && Array.isArray(data)) setItems(data.map(normalizeQueueItem));
      })
      .catch(() => {
        if (!cancelled) setItems(FALLBACK_QUEUE_EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function resolveItem(id, value, override = false) {
    const item = items.find(entry => entry.id === id);
    setItems(current => current.filter(entry => entry.id !== id));
    setOverrideValues(current => ({ ...current, [id]: override ? value : '' }));
    try {
      await apiRequest(`/api/queue/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: value || item?.recommendation, override }),
      });
    } catch {
      // Local optimistic state is kept if the API is offline during UI review.
    }
  }

  return (
    <AppShell active="queue" queueBadge={items.length}>
      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Expert review queue</p>
            <h1>Classification Decisions</h1>
          </div>
          <div className="tenant-pill queue-pill">
            <AlertTriangle size={16} />
            <span>{items.length} pending</span>
          </div>
        </header>

        <section className="review-list" aria-label="Expert review queue">
          {items.length === 0 ? (
            <article className="empty-panel">
              <CheckCircle2 size={28} />
              <h2>Queue clear</h2>
              <p>All low-confidence fields have been confirmed or overridden.</p>
            </article>
          ) : items.map((item) => (
            <article className="review-card" key={item.id}>
              <div className="review-topline">
                <div>
                  <p className="eyebrow">{item.programmeName}</p>
                  <h2>{item.fieldName}</h2>
                </div>
                <strong>{formatQueueConfidence(item.confidence)}</strong>
              </div>

              <div className="recommendation-box">
                <span>System recommendation</span>
                <strong>{item.recommendation}</strong>
                <p>{item.rationale}</p>
              </div>

              <div className="alternatives-row">
                {item.alternatives.map((alternative) => (
                  <button type="button" key={alternative} onClick={() => setOverrideValues({ ...overrideValues, [item.id]: alternative })}>
                    {alternative}
                  </button>
                ))}
              </div>

              <div className="override-row">
                <input
                  type="text"
                  placeholder="Override value"
                  value={overrideValues[item.id] || ''}
                  onChange={(event) => setOverrideValues({ ...overrideValues, [item.id]: event.target.value })}
                />
                <button className="secondary-action" type="button" onClick={() => resolveItem(item.id, item.recommendation)}>
                  <Check size={17} />
                  <span>Confirm</span>
                </button>
                <button
                  className="secondary-action"
                  type="button"
                  disabled={!overrideValues[item.id]}
                  onClick={() => resolveItem(item.id, overrideValues[item.id], true)}
                >
                  <Edit3 size={17} />
                  <span>Override</span>
                </button>
              </div>
            </article>
          ))}
        </section>
      </section>
    </AppShell>
  );
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadWord(filename, html) {
  const blob = new Blob([html], { type: 'application/msword;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function KnowledgePage() {
  const { records, source } = useLiveRecords();
  const querySynthesisId = new URLSearchParams(window.location.search).get('synthesis_id') || '';
  const eligibleRecords = records.filter(record => ['Tier 1', 'Tier 2'].includes(record.eqs_tier));
  const [recordId, setRecordId] = useState(eligibleRecords[0]?.adei_record_id || '');
  const [audience, setAudience] = useState(knowledgeAudiences[0].id);
  const [brief, setBrief] = useState('');
  const [briefProduct, setBriefProduct] = useState(null);
  const [synthesisId, setSynthesisId] = useState(querySynthesisId);
  const [synthesis, setSynthesis] = useState(null);
  const [synthesisLoading, setSynthesisLoading] = useState(Boolean(querySynthesisId));
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    if (synthesisId) return;
    if (!eligibleRecords.length) return;
    if (!eligibleRecords.some(record => record.adei_record_id === recordId)) {
      setRecordId(eligibleRecords[0].adei_record_id);
    }
  }, [eligibleRecords, recordId, synthesisId]);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('synthesis_id') || '';
    setSynthesisId(id);
    if (!id) {
      setSynthesis(null);
      setSynthesisLoading(false);
      return;
    }
    setSynthesisLoading(true);
    apiRequest(`/api/strategic-synthesis/${id}`)
      .then(data => setSynthesis(data))
      .catch(() => setSynthesis(null))
      .finally(() => setSynthesisLoading(false));
  }, []);

  const selectedRecord = eligibleRecords.find(record => record.adei_record_id === recordId) || eligibleRecords[0];
  const selectedAudience = knowledgeAudiences.find(item => item.id === audience) || knowledgeAudiences[0];
  const synthesisRecords = synthesis?.record_ids
    ? records.filter(record => synthesis.record_ids.includes(record.id) || synthesis.record_ids.includes(record.adei_record_id))
    : [];
  const displayProgrammeName = synthesisId
    ? (briefProduct?.programme_name || synthesis?.title || 'Strategic synthesis')
    : selectedRecord?.programme_name;

  if (!selectedRecord && !synthesisId) {
    return (
      <AppShell active="knowledge">
        <section className="dashboard-main">
          <article className="empty-panel">
            <FileText size={28} />
            <h2>No eligible records</h2>
            <p>Knowledge products require Tier 1 or Tier 2 records.</p>
          </article>
        </section>
      </AppShell>
    );
  }

  async function generateBrief() {
    if (!selectedRecord && !synthesisId) return;
    setIsGenerating(true);
    setBriefProduct(null);
    try {
      const body = synthesisId
        ? { synthesis_id: synthesisId, audience }
        : { record_id: selectedRecord.adei_record_id || selectedRecord.id, audience };
      const product = await apiRequest('/api/knowledge-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setBrief(product.brief || product.content || '');
      setBriefProduct(product);
      return;
    } catch {
      // Keep the interface usable if the local API is offline or Anthropic is unavailable.
    } finally {
      setIsGenerating(false);
    }
    const output = [
      `${selectedAudience.label} Brief: ${selectedRecord.programme_name}`,
      '',
      `Evidence confidence: ${selectedRecord.eqs_tier} | EQS ${selectedRecord.eqs_composite}`,
      '',
      `Core finding: ${selectedRecord.key_finding_1}`,
      '',
      `Decision implication: ${selectedRecord.decision_relevance}`,
      '',
      `Why this matters for ${selectedAudience.label}: ${selectedAudience.focus}.`,
      '',
      `Caveat: ${selectedRecord.limitations}`,
      '',
      `Recommended next action: ${selectedRecord.evidence_gap}`,
    ].join('\n');
    setBrief(output);
  }

  function reportSections() {
    if (synthesisId) {
      return [
        ['EXECUTIVE SUMMARY', brief || 'Synthesis brief pending generation.'],
        ['KEY FINDING', (synthesis?.findings || []).map(item => item.finding).join(' ')],
        ['INVESTMENT AND REACH', (synthesis?.leverage_points || []).map(item => item.rationale).join(' ')],
        ['DECISION IMPLICATION', (synthesis?.leverage_points || []).map(item => item.action).join(' ')],
        ['EVIDENCE CONFIDENCE', `Based on synthesis of ${synthesis?.record_count || briefProduct?.source_record_count || 0} records.`],
        ['RECOMMENDED ACTION', (synthesis?.leverage_points || [])[0]?.action || 'Review the synthesis and select the relevant audience action.'],
        ['SUPPORTING RECORDS', (synthesis?.record_ids || []).join(' · ')],
      ];
    }
    return [
      ['EXECUTIVE SUMMARY', brief || `${selectedRecord.programme_name} is a ${selectedRecord.eqs_tier} record with EQS ${selectedRecord.eqs_composite}.`],
      ['KEY FINDING', selectedRecord.key_finding_1],
      ['INVESTMENT AND REACH', selectedRecord.decision_relevance || selectedRecord.population_served],
      ['DECISION IMPLICATION', selectedRecord.evidence_gap_1 || selectedRecord.evidence_gap || selectedRecord.decision_relevance],
      ['EVIDENCE CONFIDENCE', `Rigour: ${formatScore(selectedRecord.dim_methodological_rigour || selectedRecord.rigour_score)}. Data quality: ${formatScore(selectedRecord.dim_data_quality || selectedRecord.data_quality_score)}. Transparency: ${formatScore(selectedRecord.dim_transparency || selectedRecord.transparency_score)}. Replicability: ${formatScore(selectedRecord.dim_replicability || selectedRecord.replicability_score)}. Policy relevance: ${formatScore(selectedRecord.policy_relevance_score)}.`],
      ['RECOMMENDED ACTION', selectedRecord.replication_conditions || selectedRecord.evidence_gap_2 || 'Review this record alongside the current commissioning calendar.'],
      ['SUPPORTING RECORDS', `${recordId(selectedRecord)} · ${selectedRecord.filename}`],
    ];
  }

  function reportText() {
    const lines = [
      `ZENEX FOUNDATION - ${selectedAudience.label.toUpperCase()} EVIDENCE BRIEF`,
      `Programme: ${displayProgrammeName}`,
      synthesisId
        ? `Based on synthesis of ${synthesis?.record_count || briefProduct?.source_record_count || 0} records`
        : `Record: ${recordId(selectedRecord)} | Classified: ${formatDisplayDate(selectedRecord.classified_at || selectedRecord.classification_date)}`,
      synthesisId
        ? `Synthesis: ${synthesisId}`
        : `Evidence tier: ${selectedRecord.eqs_tier} | EQS: ${selectedRecord.eqs_composite}/5.0`,
      '',
      ...reportSections().flatMap(([title, body]) => [title, formatRecordValue(body), '']),
    ];
    return lines.join('\n');
  }

  async function copyBrief() {
    await navigator.clipboard?.writeText(reportText());
  }

  return (
    <AppShell active="knowledge">
      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Knowledge products</p>
            <h1>Generate Audience Brief</h1>
          </div>
          <button className="primary-action" type="button" onClick={generateBrief}>
            <Edit3 size={18} />
            <span>{isGenerating ? `Generating ${selectedAudience.label} brief for ${displayProgrammeName}...` : 'Generate Brief'}</span>
          </button>
        </header>

        {synthesisId && (
          <div className="synthesis-context-banner">
            <span>
              {synthesisLoading
                ? 'Loading synthesis context...'
                : `Generating from synthesis of ${synthesis?.record_count || 0} records: ${synthesis?.title || synthesisId}`}
            </span>
            <a href={`/synthesise?records=${(synthesis?.record_ids || []).join(',')}`}>
              View synthesis
            </a>
          </div>
        )}

        <section className="knowledge-grid">
          <article className="selector-panel">
            <div className="panel-title">
              <FileText size={20} />
              <span>{synthesisId ? 'Synthesis context' : `Record selector · ${source === 'live' ? 'Live API' : 'Offline preview'}`}</span>
            </div>
            {synthesisId ? (
              <div className="synthesis-readonly-records">
                {(synthesisRecords.length ? synthesisRecords : (synthesis?.record_ids || []).map(id => ({ id, programme_name: id, eqs_tier: 'Record', eqs_composite: 'Not recorded' }))).map(record => (
                  <article className="record-chip readonly" key={recordId(record)}>
                    <span className="chip-programme">{record.programme_name}</span>
                    <span className="chip-tier">{record.eqs_tier} · EQS {record.eqs_composite}</span>
                  </article>
                ))}
              </div>
            ) : (
              <div className="record-picker">
                {eligibleRecords.map((record) => (
                  <button
                    className={record.adei_record_id === recordId ? 'selected' : ''}
                    type="button"
                    key={record.adei_record_id}
                    onClick={() => {
                      setRecordId(record.adei_record_id);
                      setBrief('');
                      setBriefProduct(null);
                    }}
                  >
                    <strong>{record.programme_name}</strong>
                    <span>{record.eqs_tier} · EQS {record.eqs_composite} · {record.province}</span>
                  </button>
                ))}
              </div>
            )}
          </article>

          <article className="audience-panel">
            <div className="panel-title">
              <Users size={20} />
              <span>Audience</span>
            </div>
            <div className="audience-grid">
              {knowledgeAudiences.map((item) => (
                <button
                  className={item.id === audience ? 'selected' : ''}
                  type="button"
                  key={item.id}
                  onClick={() => {
                    setAudience(item.id);
                    setBrief('');
                    setBriefProduct(null);
                  }}
                >
                  <strong>{item.label}</strong>
                  <span>{item.focus}</span>
                </button>
              ))}
            </div>
          </article>
        </section>

        <section className="brief-panel" aria-label="Generated knowledge product">
          <div className="brief-header">
            <div>
              <p className="eyebrow">{selectedAudience.label} output</p>
              <h2>{displayProgrammeName}</h2>
              {synthesisId && <p>Based on synthesis of {synthesis?.record_count || briefProduct?.source_record_count || 0} records</p>}
            </div>
            <div className="brief-actions">
              <button className="secondary-action" type="button" disabled={!brief && !selectedRecord} onClick={copyBrief}>
                <ClipboardCopy size={17} />
                <span>Copy</span>
              </button>
              <button className="secondary-action" type="button" disabled={!brief} onClick={() => window.print()}>
                <Download size={17} />
                <span>Download PDF</span>
              </button>
              <button className="secondary-action" type="button" disabled={!brief} onClick={() => downloadWord(`${synthesisId || recordId(selectedRecord)}-${audience}.doc`, reportText().replace(/\n/g, '<br>'))}>
                <Download size={17} />
                <span>Download Word</span>
              </button>
              <button className="btn-ghost" type="button" disabled={!briefProduct?.provenance_id} onClick={() => navigate(`/provenance/${briefProduct.provenance_id}`)}>
                View Provenance
              </button>
            </div>
          </div>

          {isGenerating ? (
            <div className="brief-loading">
              <span className="pulse-dot" />
              <strong>Generating {selectedAudience.label} brief for {displayProgrammeName}...</strong>
            </div>
          ) : brief ? (
            <article className="report-card">
              <header>
                <h2>ZENEX FOUNDATION - {selectedAudience.label.toUpperCase()} EVIDENCE BRIEF</h2>
                <p>Programme: {displayProgrammeName}</p>
                {synthesisId ? (
                  <>
                    <p>Based on synthesis of {synthesis?.record_count || briefProduct?.source_record_count || 0} records</p>
                    <p>Synthesis: {synthesisId}</p>
                  </>
                ) : (
                  <>
                    <p>Record: {recordId(selectedRecord)} | Classified: {formatDisplayDate(selectedRecord.classified_at || selectedRecord.classification_date)}</p>
                    <p>Evidence tier: {selectedRecord.eqs_tier} | EQS: {selectedRecord.eqs_composite}/5.0</p>
                  </>
                )}
              </header>
              {reportSections().map(([title, body]) => (
                <section key={title}>
                  <h3>{title}</h3>
                  <p>{formatRecordValue(body)}</p>
                </section>
              ))}
              <div className="report-export-row">
                <button className="secondary-action" type="button" onClick={copyBrief}>
                  <ClipboardCopy size={17} />
                  <span>Copy</span>
                </button>
                <button className="secondary-action" type="button" onClick={() => window.print()}>
                  <Download size={17} />
                  <span>Download PDF</span>
                </button>
                <button className="secondary-action" type="button" onClick={() => downloadWord(`${synthesisId || recordId(selectedRecord)}-${audience}.doc`, reportText().replace(/\n/g, '<br>'))}>
                  <Download size={17} />
                  <span>Download Word</span>
                </button>
                <button className="btn-ghost" type="button" disabled={!briefProduct?.provenance_id} onClick={() => navigate(`/provenance/${briefProduct.provenance_id}`)}>
                  View Provenance
                </button>
              </div>
            </article>
          ) : (
            <pre className="brief-body">Select a record and audience, then generate a brief.</pre>
          )}
        </section>
      </section>
    </AppShell>
  );
}

function ProvenancePage({ id }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const provenanceId = id || window.location.pathname.split('/').pop();
    apiRequest(`/api/provenance/${provenanceId}`)
      .then(d => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <AppShell active="knowledge">
        <section className="dashboard-main provenance-page">
          <p>Loading provenance record...</p>
        </section>
      </AppShell>
    );
  }

  if (!data) {
    return (
      <AppShell active="knowledge">
        <section className="dashboard-main provenance-page">
          <p>Provenance record not found.</p>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell active="knowledge">
      <section className="dashboard-main provenance-page">
        <header className="dashboard-header page-header">
          <div>
            <p className="eyebrow">Evidence governance</p>
            <h1>Evidence Provenance Record</h1>
            <p className="page-subheader">Complete audit chain for this audience brief</p>
          </div>
        </header>

        <section className="provenance-layer">
          <h2>Layer 1 - Source Documents</h2>
          <table className="provenance-table">
            <thead>
              <tr>
                <th>Record ID</th>
                <th>Programme</th>
                <th>Type</th>
                <th>EQS</th>
                <th>Classified</th>
              </tr>
            </thead>
            <tbody>
              {(data.source_records || []).map(r => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.programme_name}</td>
                  <td>{r.document_type}</td>
                  <td>{r.eqs_composite}</td>
                  <td>{r.classified_at ? new Date(r.classified_at).toLocaleDateString('en-GB') : 'Not recorded'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {data.synthesis && (
          <section className="provenance-layer">
            <h2>Layer 2 - Strategic Synthesis</h2>
            <div className="provenance-detail">
              <div>Generated: {new Date(data.synthesis.generated_at).toLocaleString('en-GB')}</div>
              <div>Findings extracted: {(data.synthesis.findings || []).length}</div>
              <div>Gaps identified: {(data.synthesis.evidence_gaps || []).length}</div>
              <div>Leverage points: {(data.synthesis.leverage_points || []).length}</div>
              <div>Status: {data.synthesis.status}</div>
              {data.synthesis.confirmed_at && (
                <div>Confirmed: {new Date(data.synthesis.confirmed_at).toLocaleString('en-GB')}</div>
              )}
            </div>
          </section>
        )}

        <section className="provenance-layer">
          <h2>Layer 3 - Audience Brief</h2>
          <div className="provenance-detail">
            <div>Audience: {data.audience}</div>
            <div>Generated: {new Date(data.generated_at).toLocaleString('en-GB')}</div>
            <div>Evidence engine: Version 1.0</div>
            <div>Word count: {data.word_count}</div>
          </div>
        </section>

        <section className="provenance-layer">
          <h2>Layer 4 - Publication Trail</h2>
          <div className="provenance-detail">
            {(data.download_log || []).length > 0
              ? (data.download_log || []).map((entry, index) => (
                <div key={`${entry.at || 'download'}-${index}`}>Downloaded: {entry.at}</div>
              ))
              : <span className="muted">No downloads recorded yet.</span>}
          </div>
        </section>

        <footer className="provenance-footer">
          This provenance record is permanent and cannot be edited. It forms part of the Zenex Foundation evidence governance record.
        </footer>
      </section>
    </AppShell>
  );
}

const userRoleOptions = [
  { value: 'EVIDENCE_ANALYST', label: 'Evidence Analyst' },
  { value: 'COMMUNICATIONS', label: 'Communications' },
  { value: 'CEO_EXEC', label: 'CEO Executive View' },
];

function roleLabel(role) {
  return userRoleOptions.find(option => option.value === role)?.label || role?.replaceAll('_', ' ') || 'Unassigned';
}

function adminApi(path, options = {}) {
  const authHeaders = browserIdToken ? { Authorization: `Bearer ${browserIdToken}` } : {};
  return apiRequest(`/api/admin${path}`, {
    ...options,
    tenant: 'admin',
    role: 'AUXEIRA_FOUNDER',
    user: 'emmanuel@auxeira.com',
    headers: {
      ...authHeaders,
      ...(options.headers || {}),
    },
  });
}

function AdminLoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const username = email.trim();
      const result = await signInWithClient(tenantConfig.adminCognitoClientId, username, password);
      if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        sessionStorage.setItem('evidenceos_new_password_session', result.Session);
        sessionStorage.setItem('evidenceos_new_password_username', username);
        sessionStorage.setItem('evidenceos_new_password_client', 'admin');
        navigateInApp('/change-password');
        return;
      }
      setInMemoryToken(result.AuthenticationResult?.IdToken || '', result.AuthenticationResult?.AccessToken || '');
      navigateInApp('/admin/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell admin-auth-shell">
      <section className="auth-panel" aria-label="Auxeira founder sign in">
        <div className="auth-identity">
          <div>
            <p className="eyebrow">Auxeira SuperAdmin</p>
            <h1>Founder Console</h1>
          </div>
        </div>

        <div className="auth-copy">
          <h2>Sign in to Admin</h2>
          <p>Use the dedicated Auxeira SuperAdmin account for platform support access.</p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            <span>Email</span>
            <div className="auth-input">
              <Mail size={18} />
              <input value={email} onChange={event => setEmail(event.target.value)} type="email" placeholder="name@auxeira.com" required />
            </div>
          </label>
          <label>
            <span>Password</span>
            <div className="auth-input">
              <LockKeyhole size={18} />
              <input value={password} onChange={event => setPassword(event.target.value)} type="password" placeholder="Password" required />
            </div>
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-action auth-action" type="submit" disabled={busy || !tenantConfig.adminCognitoClientId}>
            <span>{busy ? 'Signing In' : 'Sign In'}</span>
            <ArrowRight size={18} strokeWidth={2.4} />
          </button>
        </form>
      </section>
    </main>
  );
}

function AdminShell({ active, children }) {
  const isAdminAuthenticated = Boolean(browserIdToken) || window.location.pathname !== '/admin/login';

  async function handleSignOut() {
    try {
      await signOutOfCognito();
    } catch {
      // Local sign-out should still complete if Cognito cannot be reached.
    } finally {
      setInMemoryToken('');
      navigateInApp('/admin/login');
    }
  }

  return (
    <main className="admin-shell">
      <header className="admin-topbar" aria-label="Auxeira admin navigation">
        <div className="admin-wordmark">
          <span>Auxeira</span>
          <i aria-hidden="true" />
          <strong>Founder Console</strong>
        </div>
        <nav className="admin-nav">
          <a className={active === 'dashboard' ? 'active' : ''} href="/admin/dashboard">
            <Gauge size={18} />
            <span>Dashboard</span>
          </a>
          <a className={active === 'tenants' ? 'active' : ''} href="/admin/tenants">
            <Database size={18} />
            <span>Tenants</span>
          </a>
          <a className={active === 'support' ? 'active' : ''} href="/admin/support">
            <KeyRound size={18} />
            <span>Support</span>
          </a>
        </nav>
        {isAdminAuthenticated ? (
          <button className="admin-login-link" type="button" onClick={handleSignOut}>
            <LockKeyhole size={16} />
            <span>Sign Out</span>
          </button>
        ) : (
          <a className="admin-login-link" href="/admin/login">
            <LockKeyhole size={16} />
            <span>Founder Sign In</span>
          </a>
        )}
      </header>
      <div className="admin-content">
        {children}
      </div>
    </main>
  );
}

function AdminDashboardPage() {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    adminApi('/dashboard').then(setStats).catch(() => setStats(null));
  }, []);
  const tiles = [
    ['Total active tenants', stats?.active_tenants ?? 0],
    ['Total documents classified', stats?.documents_classified ?? 0],
    ['Total users', stats?.total_users ?? 0],
    ['Anthropic spend this month', `R${stats?.anthropic_spend_month ?? 0}`],
  ];

  return (
    <AdminShell active="dashboard">
      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Founder console</p>
            <h1>Admin Dashboard</h1>
          </div>
        </header>
        <section className="kpi-grid">
          {tiles.map(([label, value]) => (
            <article className="metric-card" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </article>
          ))}
        </section>
      </section>
    </AdminShell>
  );
}

function AdminTenantsPage() {
  const [tenants, setTenants] = useState([]);
  const [selected, setSelected] = useState('zenex');
  const [records, setRecords] = useState([]);

  useEffect(() => {
    adminApi('/tenants').then(data => {
      setTenants(Array.isArray(data) ? data : []);
      if (data?.[0]?.slug) setSelected(data[0].slug);
    }).catch(() => setTenants([]));
  }, []);

  useEffect(() => {
    if (!selected) return;
    adminApi(`/tenants/${selected}/records`).then(data => {
      setRecords(Array.isArray(data) ? data.map(normalizeRecord) : []);
    }).catch(() => setRecords([]));
  }, [selected]);

  return (
    <AdminShell active="tenants">
      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Admin</p>
            <h1>Tenants</h1>
          </div>
        </header>

        <section className="table-panel">
          <table className="records-table users-table">
            <thead>
              <tr>
                <th>Tenant name</th>
                <th>Status</th>
                <th>Users</th>
                <th>Documents</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map(tenant => (
                <tr key={tenant.slug} onClick={() => setSelected(tenant.slug)}>
                  <td>{tenant.name}</td>
                  <td>{tenant.status}</td>
                  <td>{tenant.users}</td>
                  <td>{tenant.documents}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="admin-corpus">
          <div className="admin-section-heading">
            <div>
              <p className="eyebrow">Corpus preview</p>
              <h2>Tenant records</h2>
            </div>
            <button className="admin-text-link" type="button" onClick={() => selected && adminApi(`/tenants/${selected}/records`).then(data => setRecords(Array.isArray(data) ? data.map(normalizeRecord) : [])).catch(() => setRecords([]))}>
              Read-only corpus: {selected}
            </button>
          </div>
          <div className="admin-record-grid">
            {records.slice(0, 8).map(record => (
              <article className="admin-record-card" key={record.adei_record_id}>
                <strong>{record.programme_name}</strong>
                <span><b>{record.eqs_tier}</b>{record.filename}</span>
              </article>
            ))}
          </div>
        </section>
      </section>
    </AdminShell>
  );
}

function AdminSupportPage() {
  const [tenants, setTenants] = useState([]);
  const [tenant, setTenant] = useState('zenex');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [records, setRecords] = useState([]);

  useEffect(() => {
    adminApi('/tenants').then(data => {
      setTenants(Array.isArray(data) ? data : []);
      if (data?.[0]?.slug) setTenant(data[0].slug);
    }).catch(() => setTenants([]));
  }, []);

  async function viewCorpus() {
    const data = await adminApi(`/tenants/${tenant}/records`);
    setRecords(Array.isArray(data) ? data.map(normalizeRecord) : []);
  }

  async function resetPassword() {
    await adminApi('/support/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant, email }),
    });
    setMessage(`Password reset started for ${email}`);
  }

  async function suspendTenantAction() {
    await adminApi('/support/suspend-tenant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant }),
    });
    setMessage(`${tenant} suspended`);
  }

  return (
    <AdminShell active="support">
      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Admin</p>
            <h1>Support</h1>
          </div>
        </header>

        {message && <div className="toast-message">{message}</div>}
        <section className="support-panel">
          <label>
            <span>Tenant</span>
            <select value={tenant} onChange={event => setTenant(event.target.value)}>
              {tenants.map(item => (
                <option key={item.slug} value={item.slug}>{item.name}</option>
              ))}
            </select>
          </label>
          <button className="secondary-action" type="button" onClick={viewCorpus}>
            <FileText size={17} />
            <span>View Corpus</span>
          </button>
          <label>
            <span>User email</span>
            <input value={email} onChange={event => setEmail(event.target.value)} type="email" placeholder="user@example.com" />
          </label>
          <button className="secondary-action" type="button" disabled={!email} onClick={resetPassword}>
            <KeyRound size={17} />
            <span>Reset Password</span>
          </button>
          <button className="secondary-action danger" type="button" onClick={suspendTenantAction}>
            <AlertTriangle size={17} />
            <span>Suspend Tenant</span>
          </button>
        </section>

        <section className="admin-corpus">
          <div className="admin-section-heading">
            <div>
              <p className="eyebrow">Read-only corpus</p>
              <h2>Corpus preview</h2>
            </div>
          </div>
          <div className="admin-record-grid">
            {records.slice(0, 8).map(record => (
              <article className="admin-record-card" key={record.adei_record_id}>
                <strong>{record.programme_name}</strong>
                <span><b>{record.eqs_tier}</b>{record.filename}</span>
              </article>
            ))}
          </div>
        </section>
      </section>
    </AdminShell>
  );
}

function SettingsPage() {
  const [usersList, setUsersList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [invite, setInvite] = useState({
    first_name: '',
    last_name: '',
    email: '',
    role: 'EVIDENCE_ANALYST',
  });

  async function loadUsers() {
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest('/api/settings/users');
      setUsersList(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function submitInvite(event) {
    event.preventDefault();
    const fullName = `${invite.first_name} ${invite.last_name}`.trim();
    setError('');
    try {
      await apiRequest('/api/settings/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: invite.email,
          full_name: fullName,
          role: invite.role,
        }),
      });
      setToast(`Invite sent to ${invite.email}`);
      setInvite({ first_name: '', last_name: '', email: '', role: 'EVIDENCE_ANALYST' });
      setInviteOpen(false);
      await loadUsers();
    } catch (err) {
      setError(err.message);
    }
  }

  async function updateUser(id, changes) {
    setError('');
    try {
      await apiRequest(`/api/settings/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      await loadUsers();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <AppShell active="settings">
      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Settings</p>
            <h1>Users</h1>
          </div>
          <button className="primary-action" type="button" onClick={() => setInviteOpen(true)}>
            <Users size={18} />
            <span>Invite User</span>
          </button>
        </header>

        {toast && <div className="toast-message">{toast}</div>}
        {error && <div className="error-banner">{error}</div>}

        <section className="settings-tabs">
          <button className="active" type="button">Users</button>
        </section>

        <section className="table-panel">
          <table className="records-table users-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Last Login</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="6">Loading users...</td></tr>
              ) : usersList.map(user => (
                <tr key={user.id}>
                  <td>{user.full_name || 'Not recorded'}</td>
                  <td>{user.email}</td>
                  <td>{roleLabel(user.role)}</td>
                  <td>{user.last_login_at ? new Date(user.last_login_at).toLocaleDateString() : 'Never'}</td>
                  <td><span className={user.is_active ? 'status-pill active' : 'status-pill'}>{user.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td>
                    <div className="row-actions">
                      <select value={user.role} onChange={event => updateUser(user.id, { role: event.target.value })}>
                        <option value="ORGANISATION_LEAD">Organisation Lead</option>
                        {userRoleOptions.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                      <button className="secondary-action danger" type="button" disabled={!user.is_active} onClick={() => updateUser(user.id, { is_active: false })}>
                        <X size={16} />
                        <span>Deactivate</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </section>

      {inviteOpen && (
        <div className="modal-backdrop" role="presentation">
          <form className="invite-modal" onSubmit={submitInvite} aria-label="Invite user">
            <div className="modal-header">
              <div>
                <p className="eyebrow">Invite user</p>
                <h2>Add a Zenex colleague</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setInviteOpen(false)} aria-label="Close invite modal">
                <X size={18} />
              </button>
            </div>

            <div className="invite-grid">
              <label>
                <span>First name</span>
                <input value={invite.first_name} onChange={event => setInvite({ ...invite, first_name: event.target.value })} required />
              </label>
              <label>
                <span>Last name</span>
                <input value={invite.last_name} onChange={event => setInvite({ ...invite, last_name: event.target.value })} required />
              </label>
              <label className="wide">
                <span>Email</span>
                <input value={invite.email} onChange={event => setInvite({ ...invite, email: event.target.value })} type="email" placeholder="name@zenexfoundation.org.za" required />
              </label>
              <label className="wide">
                <span>Role</span>
                <select value={invite.role} onChange={event => setInvite({ ...invite, role: event.target.value })}>
                  {userRoleOptions.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="modal-actions">
              <button className="secondary-action" type="button" onClick={() => setInviteOpen(false)}>Cancel</button>
              <button className="primary-action" type="submit">
                <span>Send Invite</span>
                <ArrowRight size={18} />
              </button>
            </div>
          </form>
        </div>
      )}
    </AppShell>
  );
}

function ExecPage() {
  const { records } = useLiveRecords();
  const [summary, setSummary] = useState(null);
  const topFindings = records.flatMap(record => [
    record.key_finding_1,
    record.key_finding_2,
  ]).filter(Boolean).slice(0, 5);
  const healthScore = summary?.evidence_health_score ?? 82;

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/exec-summary', { role: 'CEO_EXEC' })
      .then(data => {
        if (!cancelled) setSummary(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="exec-shell">
      <section className="exec-header">
        <div>
          <img src={tenantConfig.logoUrl} alt="Zenex Foundation" />
          <p className="eyebrow">Executive evidence link</p>
          <h1>Weekly Evidence Summary</h1>
        </div>
        <div className="exec-auth-chip">
          <KeyRound size={16} />
          <span>Email-link access</span>
        </div>
      </section>

      <section className="exec-score-card">
        <div>
          <p className="eyebrow">Evidence Health Score</p>
          <strong>{healthScore}</strong>
          <span>Strong portfolio readiness with targeted evidence gaps.</span>
        </div>
        <Gauge size={68} />
      </section>

      <section className="exec-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Top 5 findings this quarter</p>
            <h2>What leadership should know</h2>
          </div>
        </div>
        <div className="exec-findings">
          {topFindings.map((finding, index) => (
            <article key={finding}>
              <span>{index + 1}</span>
              <p>{finding}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="exec-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Decision Capital</p>
            <h2>Current leadership signal</h2>
          </div>
          <TrendingUp size={24} />
        </div>
        <div className="exec-decision-grid">
          <article>
            <strong>3</strong>
            <span>Briefs ready for senior decision use</span>
          </article>
          <article>
            <strong>{summary?.queue_items_pending ?? 2}</strong>
            <span>Evidence gaps or queue items needing attention</span>
          </article>
          <article>
            <strong>1</strong>
            <span>Scale pathway supported with Tier 1 evidence</span>
          </article>
        </div>
      </section>
    </main>
  );
}

function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const updatePath = () => setPath(window.location.pathname);
    window.addEventListener('popstate', updatePath);
    window.addEventListener('evidenceos:navigate', updatePath);
    return () => {
      window.removeEventListener('popstate', updatePath);
      window.removeEventListener('evidenceos:navigate', updatePath);
    };
  }, []);

  if (path === '/admin/login') return <AdminLoginPage />;
  if (path === '/admin/dashboard') return <AdminDashboardPage />;
  if (path === '/admin/tenants') return <AdminTenantsPage />;
  if (path === '/admin/support') return <AdminSupportPage />;
  if (path === '/login') return <LoginPage />;
  if (path === '/change-password') return <ChangePasswordPage />;
  if (path === '/dashboard') return <DashboardPage />;
  if (path === '/records') return <RecordsPage />;
  if (path === '/synthesise') return <SynthesisePage />;
  if (path === '/ask') return <AskZenexPage />;
  if (path === '/classify') return <ClassifyPage />;
  if (path === '/queue') return <QueuePage />;
  if (path === '/products') return <KnowledgePage />;
  if (path === '/knowledge') return <KnowledgePage />;
  if (path.startsWith('/provenance/')) return <ProvenancePage />;
  if (path === '/settings') return <SettingsPage />;
  if (path === '/exec') return <ExecPage />;
  return <LandingPage />;
}

createRoot(document.getElementById('root')).render(<App />);

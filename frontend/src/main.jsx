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
  KeyRound,
  Layers3,
  LockKeyhole,
  Mail,
  Search,
  ShieldCheck,
  Sparkles,
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

const mockReviewQueue = [
  {
    id: 'QR-ZEN-001',
    record: 'Foundation Phase Literacy',
    fieldName: 'effect_size',
    recommendation: '0.32 SD',
    confidence: 0.58,
    alternatives: ['0.28 SD', 'Positive direction only', 'Not enough evidence'],
    rationale: 'Reported in learner assessment appendix but confidence is below direct acceptance threshold.',
  },
  {
    id: 'QR-ZEN-002',
    record: 'Numeracy Recovery',
    fieldName: 'cost_data_source',
    recommendation: 'Management budget summary',
    confidence: 0.52,
    alternatives: ['No audited cost data', 'Approved Proxy Library', 'Unknown'],
    rationale: 'Protocol amendment PA3 requires audited financials or approved proxy before SROI use.',
  },
  {
    id: 'QR-ZEN-003',
    record: 'School Leadership Support',
    fieldName: 'decision_relevance',
    recommendation: 'Medium',
    confidence: 0.61,
    alternatives: ['High', 'Low', 'Commissioning only'],
    rationale: 'Finding challenges a common assumption but evidence quality is mixed across source reports.',
  },
];

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
  'Run ADEI 55-field classification',
  'Apply six protocol amendments',
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

const mockRecords = [
  {
    adei_record_id: 'ADEI-ZEN-001',
    tenant_id: 'zenex',
    filename: 'Zenex Grade R Literacy Evaluation 2024.pdf',
    source_uri: 's3://auxeira-evidenceos-zenex/raw/documents/grade-r-literacy-2024.pdf',
    institution: 'Zenex Foundation',
    programme_name: 'Foundation Phase Literacy',
    document_type: 'Impact Evaluation',
    publication_year: 2024,
    classification_date: '2026-07-24',
    evaluation_design: 'Quasi-experimental matched comparison',
    methodology: 'Mixed methods with learner assessment and classroom observation',
    sample_size: '2,480 learners',
    unit_of_analysis: 'Learner, teacher, school',
    province: 'Gauteng',
    district: 'Johannesburg East',
    phase: 'Foundation Phase',
    grade: 'Grade R',
    subject_area: 'Literacy',
    intervention_type: 'Teacher coaching and reading resources',
    implementation_period: '2022-2024',
    population_served: 'Learners in under-resourced primary schools',
    comparison_group: 'Matched non-participating schools',
    data_sources: 'Learner tests, teacher logs, observations, interviews',
    baseline_available: 'Yes',
    endline_available: 'Yes',
    key_finding_1: 'Learners gained the equivalent of 0.32 standard deviations in early literacy.',
    key_finding_2: 'Teacher coaching fidelity predicted stronger classroom uptake.',
    key_finding_3: 'Resource use varied sharply by school management support.',
    null_findings: 'No statistically significant maths spillover effect detected.',
    non_significant_variables: 'Attendance, caregiver workshop exposure',
    effect_direction: 'Positive literacy effect',
    effect_size: '0.32 SD',
    cost_data_source: 'Audited grant expenditure schedule',
    audited_financials_used: 'Yes',
    sroi_ready: 'Yes',
    policy_alignment: 'DBE Foundation Phase reading strategy',
    decision_relevance: 'High: supports scale pathway with coaching fidelity guardrails',
    assumption_challenge: 'Confirms coaching matters more than resource delivery alone',
    evidence_gap: 'Longer-term tracking into Grade 3 comprehension',
    replication_conditions: 'Coaching intensity, principal support, aligned reading materials',
    limitations: 'Province coverage limited to Gauteng',
    equity_considerations: 'Strongest gains in schools with lower baseline scores',
    data_quality_score: 4.2,
    rigour_score: 4.4,
    transparency_score: 4.1,
    replicability_score: 3.8,
    policy_relevance_score: 4.7,
    eqs_composite: 4.3,
    eqs_tier: 'Tier 1',
    confidence_tier: 'TIER_1',
    board_citable: 'Yes',
    evidence_capital_score: 91,
    half_life_rating: 'Current',
    audience_relevance: 'Board, DBE National, Co-Funder',
    expert_review_required: 'No',
  },
  {
    adei_record_id: 'ADEI-ZEN-002',
    tenant_id: 'zenex',
    filename: 'Eastern Cape Numeracy Process Review.docx',
    source_uri: 's3://auxeira-evidenceos-zenex/raw/documents/ec-numeracy-process-review.docx',
    institution: 'Zenex Foundation',
    programme_name: 'Numeracy Recovery',
    document_type: 'Process Evaluation',
    publication_year: 2023,
    classification_date: '2026-07-24',
    evaluation_design: 'Implementation review',
    methodology: 'School visits, teacher interviews, programme records',
    sample_size: '62 teachers',
    unit_of_analysis: 'Teacher, school',
    province: 'Eastern Cape',
    district: 'OR Tambo Inland',
    phase: 'Foundation Phase',
    grade: 'Grade 1-3',
    subject_area: 'Numeracy',
    intervention_type: 'Teacher professional development',
    implementation_period: '2021-2023',
    population_served: 'Foundation Phase teachers',
    comparison_group: 'None',
    data_sources: 'Interviews, attendance registers, facilitator notes',
    baseline_available: 'Partial',
    endline_available: 'No',
    key_finding_1: 'Teacher attendance was highest where circuit managers actively reinforced participation.',
    key_finding_2: 'Materials reached schools on time in 78% of sampled sites.',
    key_finding_3: 'Coach workload constrained follow-up cycles.',
    null_findings: 'No causal learner outcome claim is made for this process evaluation.',
    non_significant_variables: 'Not applicable',
    effect_direction: 'Implementation learning',
    effect_size: 'Not estimated',
    cost_data_source: 'Management budget summary',
    audited_financials_used: 'No',
    sroi_ready: 'No',
    policy_alignment: 'Provincial numeracy recovery priorities',
    decision_relevance: 'Medium: improves implementation design',
    assumption_challenge: 'Challenges assumption that training attendance alone drives adoption',
    evidence_gap: 'Learner outcome endline required',
    replication_conditions: 'Circuit manager engagement and coach load controls',
    limitations: 'No comparison group; self-reported teacher practice',
    equity_considerations: 'Rural travel constraints affected coaching dosage',
    data_quality_score: 3.4,
    rigour_score: 2.8,
    transparency_score: 3.6,
    replicability_score: 3.3,
    policy_relevance_score: 4.1,
    eqs_composite: 3.3,
    eqs_tier: 'Tier 2',
    confidence_tier: 'TIER_2',
    board_citable: 'With caveat',
    evidence_capital_score: 72,
    half_life_rating: 'Current',
    audience_relevance: 'Organisation Lead, Evidence Analyst',
    expert_review_required: 'Yes',
  },
  {
    adei_record_id: 'ADEI-ZEN-003',
    tenant_id: 'zenex',
    filename: 'Western Cape School Leadership Synthesis.pptx',
    source_uri: 's3://auxeira-evidenceos-zenex/raw/documents/wc-leadership-synthesis.pptx',
    institution: 'Zenex Foundation',
    programme_name: 'School Leadership Support',
    document_type: 'Synthesis',
    publication_year: 2022,
    classification_date: '2026-07-24',
    evaluation_design: 'Narrative synthesis',
    methodology: 'Document review and stakeholder validation',
    sample_size: '14 source reports',
    unit_of_analysis: 'School, leadership team',
    province: 'Western Cape',
    district: 'Cape Winelands',
    phase: 'Senior Phase',
    grade: 'Grade 7-9',
    subject_area: 'School leadership',
    intervention_type: 'Leadership development',
    implementation_period: '2018-2022',
    population_served: 'School management teams',
    comparison_group: 'Not applicable',
    data_sources: 'Evaluation reports, programme memos, workshop data',
    baseline_available: 'No',
    endline_available: 'No',
    key_finding_1: 'Leadership routines improved planning discipline but did not consistently shift learner outcomes.',
    key_finding_2: 'District alignment was the strongest predictor of sustained use.',
    key_finding_3: 'Evidence is strongest for management practice, weaker for achievement outcomes.',
    null_findings: 'Learner achievement effect remains unproven.',
    non_significant_variables: 'Learner achievement measures across source reports',
    effect_direction: 'Mixed',
    effect_size: 'Not pooled',
    cost_data_source: 'No audited cost data',
    audited_financials_used: 'No',
    sroi_ready: 'No',
    policy_alignment: 'School management and accountability priorities',
    decision_relevance: 'Medium: useful for commissioning stronger endline studies',
    assumption_challenge: 'Questions direct link between leadership training and learner gains',
    evidence_gap: 'Outcome-linked longitudinal design',
    replication_conditions: 'District endorsement and leadership practice tracking',
    limitations: 'Heterogeneous source quality',
    equity_considerations: 'Small rural school evidence is thin',
    data_quality_score: 3.1,
    rigour_score: 2.6,
    transparency_score: 3.2,
    replicability_score: 2.9,
    policy_relevance_score: 3.8,
    eqs_composite: 3.0,
    eqs_tier: 'Tier 2',
    confidence_tier: 'TIER_2',
    board_citable: 'With caveat',
    evidence_capital_score: 66,
    half_life_rating: 'Aging',
    audience_relevance: 'Evidence Analyst, CEO',
    expert_review_required: 'Yes',
  },
];

const API_BASE = tenantConfig.apiUrl.replace(/\/$/, '');
let browserIdToken = '';

function consumeIdTokenFromHash() {
  if (!window.location.hash.includes('id_token=')) return '';
  const params = new URLSearchParams(window.location.hash.slice(1));
  browserIdToken = params.get('id_token') || '';
  window.history.replaceState(null, '', window.location.pathname);
  return browserIdToken;
}

consumeIdTokenFromHash();

function setInMemoryToken(token) {
  browserIdToken = token || '';
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
  if (role === 'COMMUNICATIONS') return '/knowledge';
  if (role === 'EVIDENCE_ANALYST') return '/records';
  return '/dashboard';
}

function navigateInApp(path) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new Event('evidenceos:navigate'));
}

async function apiRequest(path, options = {}) {
  const headers = {
    'x-evidenceos-tenant': options.tenant || tenantConfig.tenant,
    'x-evidenceos-role': options.role || 'ORGANISATION_LEAD',
    ...(browserIdToken ? { Authorization: `Bearer ${browserIdToken}` } : {}),
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
    publication_year: record.publication_year || record.year || 'Not captured',
    classification_date: record.classification_date || record.classified_at || 'Not captured',
    province: record.province || record.provinces || 'Not captured',
    phase: record.phase || 'Not captured',
    eqs_tier: String(tier).replace('TIER_', 'Tier '),
    confidence_tier: record.confidence_tier || tier,
    eqs_composite: record.eqs_composite || record.evidence_capital_score || 'N/A',
    key_finding_1: record.key_finding_1 || 'No primary finding captured.',
    key_finding_2: record.key_finding_2 || 'No secondary finding captured.',
    key_finding_3: record.key_finding_3 || 'No tertiary finding captured.',
  };
}

function normalizeQueueItem(item) {
  return {
    id: item.id,
    record: item.document || item.record || item.record_id || 'Evidence record',
    fieldName: item.field_name || item.field || 'classification_field',
    recommendation: item.recommendation || item.claude_value || 'Review required',
    confidence: Number(item.confidence || item.claude_confidence || 0),
    alternatives: item.alternatives || ['Confirm recommendation', 'Override manually', 'Defer review'],
    rationale: item.question || item.rationale || 'Low-confidence classification requires Organisation Lead review.',
  };
}

function useLiveRecords() {
  const [records, setRecords] = useState(mockRecords);
  const [source, setSource] = useState('mock');

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/records')
      .then(data => {
        if (!cancelled && Array.isArray(data)) {
          setRecords(data.map(normalizeRecord));
          setSource('api');
        }
      })
      .catch(() => {
        if (!cancelled) setSource('mock');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { records, source };
}

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
            <a className="request-access-link" href="mailto:hello@auxeira.com?subject=EvidenceOS%20Access%20Request%20%E2%80%94%20Zenex%20Foundation">
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
      const result = await signInWithCognito(email.trim().toLowerCase(), password);
      if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        sessionStorage.setItem('evidenceos_new_password_session', result.Session);
        sessionStorage.setItem('evidenceos_new_password_username', email.trim().toLowerCase());
        navigateInApp('/change-password');
        return;
      }
      const idToken = result.AuthenticationResult?.IdToken || '';
      setInMemoryToken(idToken);
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
      setInMemoryToken(idToken);
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

function queueCount() {
  return mockReviewQueue.length;
}

function DashboardNav({ active, queueBadge = queueCount() }) {
  return (
    <>
      <aside className="dashboard-sidebar" aria-label="EvidenceOS navigation">
        <div className="sidebar-brand">
          <img src={tenantConfig.logoUrl} alt="Zenex Foundation" />
          <span>EvidenceOS</span>
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
          <a className={active === 'queue' ? 'active' : ''} href="/queue">
            <CheckCircle2 size={18} />
            <span>Review</span>
            <strong className="nav-badge">{queueBadge}</strong>
          </a>
          <a className={active === 'knowledge' ? 'active' : ''} href="/knowledge">
            <Sparkles size={18} />
            <span>Products</span>
          </a>
          <a className={active === 'settings' ? 'active' : ''} href="/settings">
            <Users size={18} />
            <span>Users</span>
          </a>
        </nav>
      </aside>
    </>
  );
}

function AppShell({ active, children, queueBadge }) {
  return (
    <main className="dashboard-shell">
      <DashboardNav active={active} queueBadge={queueBadge} />
      {children}
    </main>
  );
}

function DashboardPage() {
  const { records } = useLiveRecords();
  const [stats, setStats] = useState(null);
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

  return (
    <AppShell active="dashboard">
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
            <span>{source === 'api' ? 'Live API' : 'Mock fallback'} · 55-field ADEI taxonomy v2.1</span>
          </div>
          <div className="records-table" role="table">
            <div className="records-row records-head" role="row">
              <span>Record</span>
              <span>Type</span>
              <span>Phase</span>
              <span>Province</span>
              <span>Tier</span>
              <span>EQS</span>
            </div>
            {filteredRecords.map((record) => (
              <button className="records-row" type="button" role="row" key={record.adei_record_id} onClick={() => setSelectedRecord(record)}>
                <span>
                  <strong>{record.programme_name}</strong>
                  <small>{record.filename}</small>
                </span>
                <span>{record.document_type}</span>
                <span>{record.phase}</span>
                <span>{record.province}</span>
                <span><mark>{record.eqs_tier}</mark></span>
                <span>{record.eqs_composite}</span>
              </button>
            ))}
          </div>
        </section>

        {selectedRecord && (
          <div className="modal-backdrop" role="presentation" onClick={() => setSelectedRecord(null)}>
            <section className="record-modal" role="dialog" aria-modal="true" aria-label="ADEI record detail" onClick={(event) => event.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <p className="eyebrow">ADEI 55-field detail</p>
                  <h2>{selectedRecord.programme_name}</h2>
                  <p>{selectedRecord.filename}</p>
                </div>
                <button className="icon-button" type="button" aria-label="Close record detail" onClick={() => setSelectedRecord(null)}>
                  <X size={18} />
                </button>
              </div>

              <div className="field-grid">
                {adeiFieldLabels.map(([field, label]) => (
                  <div className="field-cell" key={field}>
                    <span>{label}</span>
                    <strong>{selectedRecord[field] == null || selectedRecord[field] === '' ? 'Not captured' : String(selectedRecord[field])}</strong>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
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
  const [items, setItems] = useState(mockReviewQueue);
  const [overrideValues, setOverrideValues] = useState({});

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/queue')
      .then(data => {
        if (!cancelled && Array.isArray(data)) setItems(data.map(normalizeQueueItem));
      })
      .catch(() => {});
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
                  <p className="eyebrow">{item.record}</p>
                  <h2>{item.fieldName}</h2>
                </div>
                <strong>{Math.round(item.confidence * 100)}% confidence</strong>
              </div>

              <div className="recommendation-box">
                <span>AI recommendation</span>
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

function KnowledgePage() {
  const { records, source } = useLiveRecords();
  const eligibleRecords = records.filter(record => ['Tier 1', 'Tier 2'].includes(record.eqs_tier));
  const [recordId, setRecordId] = useState(eligibleRecords[0]?.adei_record_id || '');
  const [audience, setAudience] = useState(knowledgeAudiences[0].id);
  const [brief, setBrief] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    if (!eligibleRecords.length) return;
    if (!eligibleRecords.some(record => record.adei_record_id === recordId)) {
      setRecordId(eligibleRecords[0].adei_record_id);
    }
  }, [eligibleRecords, recordId]);

  const selectedRecord = eligibleRecords.find(record => record.adei_record_id === recordId) || eligibleRecords[0];
  const selectedAudience = knowledgeAudiences.find(item => item.id === audience) || knowledgeAudiences[0];

  if (!selectedRecord) {
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
    if (!selectedRecord) return;
    setIsGenerating(true);
    try {
      const product = await apiRequest('/api/knowledge-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record_id: selectedRecord.adei_record_id || selectedRecord.id, audience }),
      });
      setBrief(product.brief || product.content || '');
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

  async function copyBrief() {
    if (!brief) return;
    await navigator.clipboard?.writeText(brief);
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
            <Sparkles size={18} />
            <span>{isGenerating ? 'Generating' : 'Generate Brief'}</span>
          </button>
        </header>

        <section className="knowledge-grid">
          <article className="selector-panel">
            <div className="panel-title">
              <FileText size={20} />
              <span>Record selector · {source === 'api' ? 'Live API' : 'Mock fallback'}</span>
            </div>
            <div className="record-picker">
              {eligibleRecords.map((record) => (
                <button
                  className={record.adei_record_id === recordId ? 'selected' : ''}
                  type="button"
                  key={record.adei_record_id}
                  onClick={() => {
                    setRecordId(record.adei_record_id);
                    setBrief('');
                  }}
                >
                  <strong>{record.programme_name}</strong>
                  <span>{record.eqs_tier} · EQS {record.eqs_composite} · {record.province}</span>
                </button>
              ))}
            </div>
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
              <h2>{selectedRecord.programme_name}</h2>
            </div>
            <div className="brief-actions">
              <button className="secondary-action" type="button" disabled={!brief} onClick={copyBrief}>
                <ClipboardCopy size={17} />
                <span>Copy</span>
              </button>
              <button className="secondary-action" type="button" disabled={!brief} onClick={() => downloadText(`${selectedRecord.adei_record_id}-${audience}.txt`, brief)}>
                <Download size={17} />
                <span>Download</span>
              </button>
            </div>
          </div>

          <pre className={brief ? 'brief-body filled' : 'brief-body'}>
            {brief || 'Select a record and audience, then generate a brief.'}
          </pre>
        </section>
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
      const result = await signInWithClient(tenantConfig.adminCognitoClientId, email.trim().toLowerCase(), password);
      if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        sessionStorage.setItem('evidenceos_new_password_session', result.Session);
        sessionStorage.setItem('evidenceos_new_password_username', email.trim().toLowerCase());
        sessionStorage.setItem('evidenceos_new_password_client', 'admin');
        navigateInApp('/change-password');
        return;
      }
      setInMemoryToken(result.AuthenticationResult?.IdToken || '');
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
  return (
    <main className="admin-shell">
      <aside className="dashboard-sidebar" aria-label="Auxeira admin navigation">
        <div className="sidebar-brand">
          <span>Auxeira</span>
          <strong>Founder Console</strong>
        </div>
        <nav className="sidebar-nav">
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
        {!browserIdToken && (
          <a className="admin-login-link" href="/admin/login">
            <LockKeyhole size={16} />
            <span>Founder Sign In</span>
          </a>
        )}
      </aside>
      {children}
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
    ['Anthropic spend this month', `$${stats?.anthropic_spend_month ?? 0}`],
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
          <div className="panel-title">
            <FileText size={20} />
            <span>Read-only corpus · {selected}</span>
          </div>
          <div className="record-picker">
            {records.slice(0, 8).map(record => (
              <button type="button" key={record.adei_record_id}>
                <strong>{record.programme_name}</strong>
                <span>{record.eqs_tier} · {record.filename}</span>
              </button>
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
          <div className="panel-title">
            <Database size={20} />
            <span>Corpus preview</span>
          </div>
          <div className="record-picker">
            {records.slice(0, 8).map(record => (
              <button type="button" key={record.adei_record_id}>
                <strong>{record.programme_name}</strong>
                <span>{record.eqs_tier} · {record.filename}</span>
              </button>
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
                  <td>{user.full_name || 'Not captured'}</td>
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
  if (path === '/classify') return <ClassifyPage />;
  if (path === '/queue') return <QueuePage />;
  if (path === '/knowledge') return <KnowledgePage />;
  if (path === '/settings') return <SettingsPage />;
  if (path === '/exec') return <ExecPage />;
  return <LandingPage />;
}

createRoot(document.getElementById('root')).render(<App />);

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Banknote,
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
  SkipForward,
  TrendingUp,
  UploadCloud,
  Users,
  X,
} from 'lucide-react';
import { tenantConfig } from './config';
import './styles.css';

const qualityDimensionFields = [
  { label: 'Methodological rigour', key: 'methodological_rigour' },
  { label: 'Data quality', key: 'data_quality' },
  { label: 'Transparency', key: 'transparency' },
  { label: 'Replicability', key: 'replicability' },
  { label: 'Context relevance', key: 'context_relevance' },
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

// Honest, time-based progress messaging for the 20-40s classification wait.
// The frontend cannot observe real backend phase transitions, so these are
// realistic delays (not fake per-360ms steps) that approximate the actual
// pipeline. The bar never reaches 100% from a timer - only the API
// resolving (success or error) advances past pct 90. See uploadAndClassify.
const CLASSIFY_PHASES = [
  { label: 'Extracting text...', subtext: '', delay: 3000, pct: 25 },
  { label: 'Classifying document structure...', subtext: '', delay: 8000, pct: 50 },
  {
    label: 'Running methodological analysis...',
    subtext: 'This may take up to 30 seconds for detailed evaluations.',
    delay: 15000,
    pct: 75,
  },
  { label: 'Calculating evidence quality score and saving record...', subtext: '', delay: 35000, pct: 90 },
];

function formatEqsTier(tier) {
  return tier ? String(tier).replace(/_/g, ' ') : 'N/A';
}

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
  if (typeof value === 'object') return JSON.stringify(value);
  return `${value}${suffix}`;
}

function briefContent(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value?.brief) return value.brief;
  if (typeof value === 'object' && value?.content) return value.content;
  return JSON.stringify(value || '');
}

const sanitise = (text) => {
  if (!text) return '';
  return String(text)
    .replace(/\u2014/g, ',')
    .replace(/\u2013/g, ',')
    .replace(/ --- /g, '. ')
    .replace(/---/g, '.');
};

function sanitiseAnswer(text) {
  return sanitise(text);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function renderMarkdown(text) {
  if (!text) return '';

  const lines = sanitiseAnswer(text).split('\n');
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (
      line.includes('|')
      && lines[i + 1]
      && /^\|?[\s\-\|]+\|?$/.test(lines[i + 1])
    ) {
      const tableLines = [];
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }

      const headers = tableLines[0]
        .split('|')
        .filter(cell => cell.trim())
        .map(cell => cell.trim());

      const rows = tableLines
        .slice(2)
        .map(row => row
          .split('|')
          .filter(cell => cell.trim())
          .map(cell => cell.trim()));

      output.push(
        '<table class="ask-table">'
        + '<thead><tr>'
        + headers.map(header => `<th>${renderInlineMarkdown(header)}</th>`).join('')
        + '</tr></thead>'
        + '<tbody>'
        + rows.map(row => (
          '<tr>'
          + row.map(cell => `<td>${renderInlineMarkdown(cell)}</td>`).join('')
          + '</tr>'
        )).join('')
        + '</tbody></table>'
      );
      continue;
    }

    if (line.startsWith('### ')) {
      output.push(`<h4 class="ask-h4">${renderInlineMarkdown(line.slice(4))}</h4>`);
    } else if (line.startsWith('## ')) {
      output.push(`<h3 class="ask-h3">${renderInlineMarkdown(line.slice(3))}</h3>`);
    } else if (line.startsWith('# ')) {
      output.push(`<h2 class="ask-h2">${renderInlineMarkdown(line.slice(2))}</h2>`);
    } else if (line.startsWith('---')) {
      output.push('<hr class="ask-hr" />');
    } else if (line.trim() === '') {
      output.push('<br />');
    } else {
      output.push(`<p class="ask-p">${renderInlineMarkdown(line)}</p>`);
    }
    i++;
  }

  return output.join('');
}

function safeRenderMarkdown(text) {
  try {
    return renderMarkdown(sanitise(text || ''));
  } catch (err) {
    console.error('Markdown render error:', err);
    return `<p>${escapeHtml(sanitise(text || ''))}</p>`;
  }
}

function hasRealContradiction(text) {
  const contradiction = sanitiseAnswer(text).trim();
  const lower = contradiction.toLowerCase();
  return contradiction.length > 20
    && !lower.startsWith('no contradiction')
    && !lower.startsWith('none')
    && !lower.startsWith('exists between');
}

function formatScore(value) {
  return value == null || value === '' ? 'Not recorded' : `${value}/5`;
}

function recordId(record) {
  return record?.adei_record_id || record?.id;
}

function PathwayBadge({ pathway }) {
  if (pathway === 'PROCESS') {
    return (
      <span className="pathway-badge process" title="Scored for implementation quality, not causal outcomes">
        Process pathway
      </span>
    );
  }
  if (pathway === 'RESEARCH') {
    return (
      <span className="pathway-badge research" title="Scored for synthesis quality and policy relevance">
        Research pathway
      </span>
    );
  }
  return null;
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

function getHealthLabel(score) {
  if (score >= 90) return { label: 'Excellent', color: '#4CAF50' };
  if (score >= 75) return { label: 'Strong', color: '#8BC34A' };
  if (score >= 60) return { label: 'Established', color: '#FFC107' };
  if (score >= 40) return { label: 'Developing', color: '#FF9800' };
  return { label: 'Early stage', color: '#EF7218' };
}

function CascadeFormulaModal({ item, onClose }) {
  if (!item) return null;
  return (
    <div className="modal-backdrop formula-backdrop" role="presentation" onClick={onClose}>
      <section className="formula-modal" role="dialog" aria-modal="true" aria-label={`${item.title} calculation`} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">Calculation method</p>
            <h2>{item.title} - How we calculate this</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close formula" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <p>{item.formula || 'N/A'}</p>
        {item.note && <small>Source note: {item.note}</small>}
      </section>
    </div>
  );
}

function AlertPriorityInfoModal({ open, onClose }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop formula-backdrop" role="presentation" onClick={onClose}>
      <section className="formula-modal" role="dialog" aria-modal="true" aria-label="How priority is determined" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">Intelligence Alerts</p>
            <h2>How priority is determined</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close explanation" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <p>
          Priority is based on strategic alignment, evidence age, investment size,
          evidence gaps, and DBE policy relevance.
        </p>
        <small>Alerts are ranked Critical, Important, or Informational from these combined factors.</small>
      </section>
    </div>
  );
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
  if (response.status === 401) {
    browserIdToken = '';
    browserAccessToken = '';
    sessionStorage.removeItem(ID_TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
    window.location.href = '/login?reason=expired';
    return undefined;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    const error = new Error(payload.error || response.statusText);
    error.status = response.status;
    error.payload = payload;
    throw error;
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

const financialSourceOptions = ['AUDITED', 'GRANT_AGREEMENT', 'MANAGEMENT_ACCOUNTS', 'PROXY', 'UNKNOWN'];

function financialEditFromRecord(record) {
  if (!record) {
    return {
      total_cost_rand: '',
      cost_data_source: '',
      cost_per_learner: '',
      financial_year: '',
      cost_notes: '',
      audited_financials_used: false,
    };
  }
  return {
    total_cost_rand: record.total_cost_rand || '',
    cost_data_source: financialSourceOptions.includes(record.cost_data_source) ? record.cost_data_source : '',
    cost_per_learner: record.cost_per_learner || '',
    financial_year: record.financial_year || '',
    cost_notes: record.cost_notes || '',
    audited_financials_used: Boolean(record.audited_financials_used),
  };
}

function RecordDetailModal({ record, onClose, userRole = currentUser().role }) {
  const [displayRecord, setDisplayRecord] = useState(record || {});
  const [financialEdit, setFinancialEdit] = useState(() => financialEditFromRecord(record));
  const [financialSaving, setFinancialSaving] = useState(false);
  const [financialSaved, setFinancialSaved] = useState(false);
  const [financialError, setFinancialError] = useState('');

  useEffect(() => {
    setDisplayRecord(record);
    setFinancialEdit(financialEditFromRecord(record));
    setFinancialSaved(false);
    setFinancialError('');
  }, [record]);

  if (!record) return null;

  async function handleSaveFinancials() {
    setFinancialSaving(true);
    setFinancialSaved(false);
    setFinancialError('');
    try {
      const payload = {
        ...financialEdit,
        audited_financials_used: financialEdit.cost_data_source === 'AUDITED' || Boolean(financialEdit.audited_financials_used),
      };
      const data = await apiRequest(`/api/records/${displayRecord.id || displayRecord.adei_record_id}/financials`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (data?.success && data.record) {
        setDisplayRecord(current => ({ ...current, ...data.record }));
        setFinancialEdit(current => ({ ...current, ...data.record }));
        setFinancialSaved(true);
        setTimeout(() => setFinancialSaved(false), 3000);
      }
    } catch (err) {
      console.error('Financial save error:', err);
      setFinancialError(err.payload?.error || err.message || 'Financial data could not be saved.');
    } finally {
      setFinancialSaving(false);
    }
  }

  const sroiEligible = financialEdit.cost_data_source === 'AUDITED' || financialEdit.cost_data_source === 'PROXY';

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="record-modal" role="dialog" aria-modal="true" aria-label="ADEI record detail" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">ADEI 55-field detail</p>
            <h2>{displayRecord.programme_name}</h2>
            <p>{displayRecord.filename}</p>
            <PathwayBadge pathway={displayRecord.eqs_scoring_pathway} />
          </div>
          <button className="icon-button" type="button" aria-label="Close record detail" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="field-grid">
          {fullRecordFields(displayRecord).map(([label, value]) => (
            <div className="field-cell" key={label}>
              <span>{label}</span>
              <strong>{formatRecordValue(value)}</strong>
            </div>
          ))}
        </div>

        {userRole === 'ORGANISATION_LEAD' && (
          <div className="financial-edit-panel">
            <div className="financial-edit-header">
              <h4>Financial Data</h4>
              <span className="financial-edit-note">
                Manually entered by Organisation Lead. Not extracted from document.
              </span>
            </div>

            <div className="financial-edit-grid">
              <div className="financial-field">
                <label>Total programme cost (R)</label>
                <input
                  type="number"
                  value={financialEdit.total_cost_rand || ''}
                  onChange={event => setFinancialEdit(prev => ({ ...prev, total_cost_rand: event.target.value }))}
                  placeholder="e.g. 4500000"
                />
              </div>

              <div className="financial-field">
                <label>Cost data source</label>
                <select
                  value={financialEdit.cost_data_source || ''}
                  onChange={event => setFinancialEdit(prev => ({ ...prev, cost_data_source: event.target.value }))}
                >
                  <option value="">Select source</option>
                  <option value="AUDITED">Audited financials</option>
                  <option value="GRANT_AGREEMENT">Grant agreement</option>
                  <option value="MANAGEMENT_ACCOUNTS">Management accounts</option>
                  <option value="PROXY">Approved proxy estimate</option>
                  <option value="UNKNOWN">Unknown</option>
                </select>
              </div>

              <div className="financial-field">
                <label>Cost per learner (R)</label>
                <input
                  type="number"
                  value={financialEdit.cost_per_learner || ''}
                  onChange={event => setFinancialEdit(prev => ({ ...prev, cost_per_learner: event.target.value }))}
                  placeholder="e.g. 1250"
                />
              </div>

              <div className="financial-field">
                <label>Financial year</label>
                <input
                  type="text"
                  value={financialEdit.financial_year || ''}
                  onChange={event => setFinancialEdit(prev => ({ ...prev, financial_year: event.target.value }))}
                  placeholder="e.g. 2022/23"
                />
              </div>
            </div>

            <div className="financial-field full-width">
              <label>Notes on cost data provenance</label>
              <textarea
                value={financialEdit.cost_notes || ''}
                onChange={event => setFinancialEdit(prev => ({ ...prev, cost_notes: event.target.value }))}
                placeholder="e.g. Sourced from Optimy grant management system. Confirmed by Finance Manager 29 July 2026."
                rows={3}
              />
            </div>

            {sroiEligible && (
              <div className="sroi-eligible-notice">
                This record will be marked SROI eligible after saving.
              </div>
            )}

            {financialError && (
              <div className="financial-save-error">
                {financialError}
              </div>
            )}

            <div className="financial-save-row">
              <button
                className="btn-primary"
                type="button"
                onClick={handleSaveFinancials}
                disabled={financialSaving}
              >
                {financialSaving ? 'Saving...' : 'Save financial data'}
              </button>

              {financialSaved && (
                <span className="financial-saved-confirm">
                  Saved. Record updated.
                  {sroiEligible ? ' SROI eligible.' : ''}
                </span>
              )}
            </div>
          </div>
        )}
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

function alertTier(alert) {
  const score = Number(alert?.priority_score);
  if (Number.isFinite(score)) {
    if (score >= 80) return 'CRITICAL';
    if (score >= 50) return 'IMPORTANT';
    return 'INFORMATIONAL';
  }
  // Legacy alerts predating priority_score fall back to their HIGH/MEDIUM/LOW priority.
  if (alert?.priority === 'HIGH') return 'CRITICAL';
  if (alert?.priority === 'LOW') return 'INFORMATIONAL';
  return 'IMPORTANT';
}

const ALERT_TIER_LABELS = {
  CRITICAL: 'Critical',
  IMPORTANT: 'Important',
  INFORMATIONAL: 'Informational',
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
  const sessionExpired = new URLSearchParams(window.location.search).get('reason') === 'expired';

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

        {sessionExpired && (
          <div className="session-expired-banner">
            Your session has expired. Please sign in again.
          </div>
        )}

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
            <span>Workspace</span>
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
  const [statsLoading, setStatsLoading] = useState(true);
  const [estate, setEstate] = useState(null);
  const [estateLoading, setEstateLoading] = useState(true);
  const [estateTypesOpen, setEstateTypesOpen] = useState(false);
  const [showProvincesModal, setShowProvincesModal] = useState(false);
  const [showYearsModal, setShowYearsModal] = useState(false);
  const [portfolio, setPortfolio] = useState(null);
  const [portfolioLoading, setPortfolioLoading] = useState(true);
  const [portfolioProgrammesOpen, setPortfolioProgrammesOpen] = useState(false);
  const [queueItems, setQueueItems] = useState(FALLBACK_QUEUE_EMPTY);
  const [queueLoading, setQueueLoading] = useState(true);
  const [cascade, setCascade] = useState(null);
  const [cascadeLoading, setCascadeLoading] = useState(true);
  const [formulaModal, setFormulaModal] = useState(null);
  const [priorityInfoOpen, setPriorityInfoOpen] = useState(false);
  const [workspaceExtra, setWorkspaceExtra] = useState({ corpus: 0, financial: 0 });
  const [completenessData, setCompletenessData] = useState(null);
  const [gaps, setGaps] = useState([]);
  const [gapsLoading, setGapsLoading] = useState(true);
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
  const totalRecords = cascade?.corpus_size || estate?.total_records || stats?.documents_classified || records.length || 0;
  const avgEqsReal = cascade?.evidence_capital?.avg_eqs != null ? Number(cascade.evidence_capital.avg_eqs) : 0;
  const avgEqs = avgEqsReal.toFixed(2);
  const gapsIdentified = portfolio?.evidence_gaps || 0;

  // Health Score: three-component additive model, max 100.
  // Quality (60): avg_eqs across ACTIVE records with non-null eqs_composite.
  // Maturity (30): corpus depth by record-count band.
  // Coverage (10): placeholder until Phase 2 gap analysis - full marks
  // when no open gaps are identified, partial marks otherwise.
  const qualityScore = (avgEqsReal / 5.0) * 60;
  const maturity = totalRecords <= 10 ? { score: 6, band: 1 }
    : totalRecords <= 25 ? { score: 12, band: 2 }
    : totalRecords <= 50 ? { score: 18, band: 3 }
    : totalRecords <= 75 ? { score: 24, band: 4 }
    : totalRecords <= 150 ? { score: 28, band: 5 }
    : { score: 30, band: 5 };
  const coverageScore = gapsIdentified > 0 ? 5 : 10;
  const evidenceHealthScore = Math.round(qualityScore + maturity.score + coverageScore);
  const healthLabel = getHealthLabel(evidenceHealthScore);

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/stats')
      .then(data => {
        if (!cancelled) {
          setStats(data);
          setStatsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setStatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/stats/estate')
      .then(data => {
        if (!cancelled) {
          setEstate(data);
          setEstateLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setEstateLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/stats/cascade')
      .then(data => {
        if (!cancelled) {
          setCascade(data);
          setCascadeLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setCascadeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/stats/portfolio')
      .then(data => {
        if (!cancelled) {
          setPortfolio(data);
          setPortfolioLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setPortfolioLoading(false);
      });
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
    let cancelled = false;
    Promise.all([
      apiRequest('/api/stats/completeness').catch(() => null),
      apiRequest('/api/financial/unconfirmed').catch(() => null),
    ]).then(([completeness, financial]) => {
      if (cancelled) return;
      setCompletenessData(completeness);
      setWorkspaceExtra({
        corpus: completeness ? (completeness.critical_gaps_count || 0) + (completeness.financial_gaps_count || 0) : 0,
        financial: financial ? (financial.count || 0) : 0,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/stats/gaps')
      .then(data => {
        if (!cancelled) setGaps(Array.isArray(data?.gaps) ? data.gaps : []);
      })
      .catch(() => {
        if (!cancelled) setGaps([]);
      })
      .finally(() => {
        if (!cancelled) setGapsLoading(false);
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

  const cascadeCards = [
    {
      title: 'Financial Capital',
      value: cascadeLoading
        ? 'Calculating...'
        : cascade?.financial_capital?.has_data
          ? cascade.financial_capital.label
          : 'Awaiting financial records',
      note: cascade?.financial_capital?.has_data
        ? cascade.financial_capital.note
        : 'Upload audited financial statements to calculate',
      formula: cascade?.financial_capital?.formula,
    },
    {
      title: 'Evidence Capital',
      value: cascadeLoading ? 'Calculating...' : cascade?.evidence_capital?.label || 'N/A',
      note: cascade?.evidence_capital?.note || 'No classified financial records yet',
      warningNote: cascade?.evidence_capital?.decay_loss_pct > 30
        ? `${formatRand(cascade.evidence_capital.decay_loss_rand)} affected by evidence aging`
        : null,
      formula: cascade?.evidence_capital?.formula,
    },
    {
      title: 'Decision Capital',
      value: cascadeLoading ? 'Calculating...' : cascade?.decision_capital?.label || 'N/A',
      note: cascade?.decision_capital?.note || '',
      formula: cascade?.decision_capital?.formula,
    },
    {
      title: 'EROI',
      value: 'In Development',
      note: 'Portfolio return score across System Adoption, Policy Influence, Learning Outcomes, Knowledge Assets and Capital Leveraged',
      costDataNote: 'EROI will be calculated once Decision Capital instances are confirmed and system adoption data is collected.',
      formula: 'Evidence Return on Investment measures the broader institutional value created by Zenex\'s evidence investment across five dimensions: System Adoption (30%), Policy Influence (20%), Learning Outcomes (20%), Knowledge Assets (15%), and Capital Leveraged (15%). Full calculation requires Decision Capital confirmation by the Director of Research and Evaluation.',
    },
  ];
  const programmeNames = [...new Set((portfolio?.programmes || []).map(item => item.programme_name).filter(Boolean))];
  const freshness = portfolio?.freshness || {};
  const totalEstateRecords = estate?.total_records || 0;
  const estateYearSubtitle = estate?.earliest_year && estate?.latest_year
    ? `${estate.earliest_year} to ${estate.latest_year}`
    : 'Not recorded';

  return (
    <AppShell active="dashboard" queueBadge={queueItems.length + workspaceExtra.corpus + workspaceExtra.financial}>
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

        <section className="estate-hero" aria-label="Evidence estate">
          <div className="estate-header">
            <div>
              <p className="eyebrow">Evidence Estate</p>
              <h2>Zenex Foundation</h2>
            </div>
            <span>Last updated: {formatDisplayDate(new Date())}</span>
          </div>
          <div className="estate-stat-grid">
            <button className="estate-stat-tile" type="button" onClick={() => setEstateTypesOpen(true)}>
              <strong>{estateLoading ? '...' : estate?.total_records || 0}</strong>
              <span>Documents Classified</span>
              <small className="estate-tile-subtitle">Classified and scored</small>
            </button>
            <article className="estate-stat-tile">
              <strong>{statsLoading ? '...' : stats?.independent_evaluations || 0}</strong>
              <span>Independent Evaluations</span>
              <small className="estate-tile-subtitle">Standalone assessments</small>
            </article>
            <article className="estate-stat-tile">
              <strong>{estateLoading ? '...' : estate?.total_programmes || 0}</strong>
              <span>Programmes</span>
              <small className="estate-tile-subtitle">Across the portfolio</small>
            </article>
            <button className="estate-stat-tile" type="button" onClick={() => setShowProvincesModal(true)}>
              <strong>{estateLoading ? '...' : estate?.total_provinces || 0}</strong>
              <span>Provinces</span>
              <small className="estate-tile-subtitle">Geographic reach</small>
            </button>
            <button className="estate-stat-tile" type="button" onClick={() => setShowYearsModal(true)}>
              <strong>{estateLoading ? '...' : estate?.years_span || 0}</strong>
              <span>Years of evidence</span>
              <small className="estate-tile-subtitle">{estateLoading ? '...' : estateYearSubtitle}</small>
            </button>
          </div>
          <p>Last document ingested: {estate?.last_ingestion ? formatDisplayDate(estate.last_ingestion) : 'Not recorded'}</p>
        </section>

        {estateTypesOpen && (
          <div className="modal-overlay" role="presentation" onClick={() => setEstateTypesOpen(false)}>
            <section className="modal-panel" role="dialog" aria-modal="true" aria-label="Evaluation types" onClick={event => event.stopPropagation()}>
              <button className="modal-close" type="button" aria-label="Close evaluation types" onClick={() => setEstateTypesOpen(false)}>
                ×
              </button>
              <h2 className="modal-title">Evaluation Types</h2>
              <p className="modal-subtitle">
                {totalEstateRecords} classified documents by type · as at {formatDisplayDate(new Date())}
              </p>

              {(estate?.type_breakdown || []).map(item => {
                const type = item.document_type || item.type || 'Unknown';
                const count = Number(item.count || 0);
                const percentage = totalEstateRecords > 0 ? Math.round((count / totalEstateRecords) * 100) : 0;
                return (
                  <div className="type-row" key={type}>
                    <span className="type-name">{type}</span>
                    <span className="type-count">{count}</span>
                    <span className="type-bar-wrap">
                      <span className="type-bar-fill" style={{ width: `${percentage}%` }} />
                    </span>
                    <span className="type-percent">{percentage}%</span>
                  </div>
                );
              })}

              <div className="modal-doc-list">
                {records.map(record => (
                  <div className="modal-doc-item" key={recordId(record)}>
                    <span className="modal-tier-badge">{record.eqs_tier}</span>
                    <span>{record.programme_name} · {record.year || record.publication_year || 'Not recorded'} · EQS {record.eqs_composite}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {showProvincesModal && (
          <div className="modal-overlay" role="presentation" onClick={() => setShowProvincesModal(false)}>
            <section className="modal-panel" role="dialog" aria-modal="true" aria-label="Provincial coverage" onClick={event => event.stopPropagation()}>
              <button className="modal-close" type="button" aria-label="Close provincial coverage" onClick={() => setShowProvincesModal(false)}>
                ×
              </button>
              <h2 className="modal-title">Provincial Coverage</h2>
              <p className="modal-subtitle">
                {estate?.total_provinces || 0} provinces represented across {estate?.total_records || 0} classified documents
              </p>

              {(estate?.province_breakdown || []).map(item => (
                <div className="type-row" key={item.province}>
                  <span className="type-name">{item.province}</span>
                  <span className="type-bar-wrap">
                    <span className="type-bar-fill" style={{ width: `${item.pct || 0}%` }} />
                  </span>
                  <span className="type-count">{item.count}</span>
                  <span className="type-percent">{item.pct || 0}%</span>
                </div>
              ))}

              <div className="modal-doc-list">
                <div className="breakdown-header">Documents by province</div>
                {records
                  .filter(record => Array.isArray(record.provinces) && record.provinces.length > 0)
                  .map(record => (
                    <div className="modal-doc-item" key={recordId(record)}>
                      <span className="modal-tier-badge">{record.eqs_tier || 'N/A'}</span>
                      <span style={{ flex: 1 }}>{record.programme_name}</span>
                      <span style={{ fontSize: '11px', color: 'var(--color-muted)' }}>
                        {record.provinces.join(', ')}
                      </span>
                    </div>
                  ))}
              </div>
            </section>
          </div>
        )}

        {showYearsModal && (
          <div className="modal-overlay" role="presentation" onClick={() => setShowYearsModal(false)}>
            <section className="modal-panel" role="dialog" aria-modal="true" aria-label="Evidence by year" onClick={event => event.stopPropagation()}>
              <button className="modal-close" type="button" aria-label="Close evidence by year" onClick={() => setShowYearsModal(false)}>
                ×
              </button>
              <h2 className="modal-title">Evidence by Year</h2>
              <p className="modal-subtitle">
                {estate?.years_span || 0} years represented across {estate?.total_records || 0} classified documents
              </p>

              {(estate?.year_breakdown || []).map(item => (
                <div className="type-row" key={item.year}>
                  <span className="type-name">{item.year || 'Not recorded'}</span>
                  <span className="type-bar-wrap">
                    <span className="type-bar-fill" style={{ width: `${item.pct || 0}%` }} />
                  </span>
                  <span className="type-count">{item.count}</span>
                  <span className="type-percent">{item.pct || 0}%</span>
                </div>
              ))}

              <div className="modal-doc-list">
                <div className="breakdown-header">Documents by year</div>
                {[...records]
                  .sort((left, right) => String(left.year || left.publication_year || '').localeCompare(String(right.year || right.publication_year || '')))
                  .map(record => (
                    <div className="modal-doc-item" key={recordId(record)}>
                      <span className="modal-tier-badge">{record.eqs_tier || 'N/A'}</span>
                      <span style={{ flex: 1 }}>{record.programme_name}</span>
                      <span style={{ fontSize: '11px', color: 'var(--color-muted)' }}>
                        {record.year || record.publication_year || 'Not recorded'} · EQS {record.eqs_composite || 'N/A'}
                      </span>
                    </div>
                  ))}
              </div>
            </section>
          </div>
        )}

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
            <div className="health-score-label" style={{ color: healthLabel.color }}>
              {healthLabel.label}
            </div>
            <div className="health-score-explanation">
              <span className="explanation-quality">
                Quality: {avgEqs}/5.0 across {totalRecords} classified documents
              </span>
              <span className="explanation-maturity">
                Corpus maturity: {totalRecords} documents classified (Band {maturity.band} of 5)
              </span>
              <span className="explanation-note">
                Health score combines evidence quality, corpus depth, and coverage. Increases as more documents are classified.
              </span>
            </div>
            <div className="score-track" aria-hidden="true">
              <span style={{ width: `${evidenceHealthScore}%` }} />
            </div>
            <p>Based on {cascade?.corpus_size || 0} classified documents. Score reflects evidence quality and currency. Increases as corpus grows.</p>
          </article>

          <article className="dimension-panel">
            <div className="panel-title">
              <BarChart3 size={20} />
              <span>Quality Dimensions</span>
            </div>
            <div className="dimension-list">
              {qualityDimensionFields.map((item) => {
                const score = stats?.quality_dimensions?.[item.key];
                const displayScore = statsLoading ? null : (score != null ? Number(score) : 0);
                return (
                  <div className="dimension-row" key={item.label}>
                    <span>{item.label}</span>
                    <div className="mini-track" aria-hidden="true">
                      <span style={{ width: `${((displayScore || 0) / 5) * 100}%` }} />
                    </div>
                    <strong>{statsLoading ? '...' : displayScore.toFixed(1)}</strong>
                  </div>
                );
              })}
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
            {cascadeCards.map((stage, index) => (
              <article className="cascade-card" key={stage.title}>
                <button className="formula-info" type="button" aria-label={`${stage.title} formula`} onClick={() => setFormulaModal(stage)}>
                  ⓘ
                </button>
                <div className="cascade-index">{String(index + 1).padStart(2, '0')}</div>
                <h3>{stage.title}</h3>
                <strong>{stage.value}</strong>
                <p>{stage.note || 'N/A'}</p>
                {stage.costDataNote && <p className="cascade-cost-note">{stage.costDataNote}</p>}
                {stage.warningNote && <p className="cascade-warning-note">{stage.warningNote}</p>}
                {index < cascadeCards.length - 1 && <ArrowRight className="cascade-arrow" size={18} />}
              </article>
            ))}
          </div>
        </section>

        <section className="portfolio-section" aria-label="Portfolio intelligence">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Portfolio Intelligence</p>
              <h2>Portfolio Intelligence</h2>
            </div>
          </div>

          <div className="portfolio-grid">
            <article className="portfolio-card">
              <h3>Evidence Freshness</h3>
              <strong>
                Current {portfolioLoading ? '...' : freshness.current_pct || 0}% |
                Aging {portfolioLoading ? '...' : freshness.aging_pct || 0}% |
                Historical {portfolioLoading ? '...' : freshness.historical_pct || 0}%
              </strong>
              <div className="freshness-bar" aria-hidden="true">
                <span className="fresh-current" style={{ width: `${freshness.current_pct || 0}%` }} />
                <span className="fresh-aging" style={{ width: `${freshness.aging_pct || 0}%` }} />
                <span className="fresh-historical" style={{ width: `${freshness.historical_pct || 0}%` }} />
              </div>
            </article>
            <article className="portfolio-card">
              <h3>Evidence Gaps</h3>
              <strong>{portfolioLoading ? '...' : portfolio?.evidence_gaps || 0} identified</strong>
              <p>Records with missing endline or documented gaps</p>
            </article>
            <article className="portfolio-card">
              <h3>Programmes Covered</h3>
              <button className="portfolio-link-button" type="button" onClick={() => setPortfolioProgrammesOpen(open => !open)}>
                {portfolioLoading ? '...' : programmeNames.length} programmes
              </button>
              {portfolioProgrammesOpen && (
                <div className="programme-popover">
                  {programmeNames.map(name => <span key={name}>{name}</span>)}
                </div>
              )}
            </article>
            <article className="portfolio-card">
              <h3>Pending Review</h3>
              <button className="portfolio-link-button" type="button" onClick={() => navigate('/queue')}>
                {portfolioLoading ? '...' : portfolio?.pending_review || 0} items
              </button>
            </article>
          </div>
        </section>

        <section className="intelligence-summary-section" aria-label="Intelligence summary">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Intelligence Summary</p>
              <h2>Where to focus next</h2>
            </div>
          </div>

          <div className="intelligence-summary-panel">
            <div className="completeness-banner">
              <div className="completeness-banner-left">
                <h3>Data Completeness</h3>
                <strong className="completeness-pct">
                  {completenessData ? `${completenessData.overall_completeness_pct ?? completenessData.completeness_score ?? 0}%` : '...'}
                </strong>
              </div>
              <div className="completeness-bar-track" aria-hidden="true">
                <div
                  className="completeness-bar-fill"
                  style={{ width: `${completenessData?.overall_completeness_pct ?? completenessData?.completeness_score ?? 0}%` }}
                />
              </div>
              <div className="completeness-banner-right">
                <p className="completeness-detail">
                  {completenessData
                    ? `${completenessData.critical_gaps_count ?? 0} of ${completenessData.total_active_records ?? 0} records have critical missing fields`
                    : 'Checking corpus completeness...'}
                </p>
                <a className="teal-link" href="/queue" onClick={(event) => { event.preventDefault(); navigate('/queue'); }}>
                  Complete in Workspace →
                </a>
              </div>
            </div>

            <div className="intelligence-summary-divider" />

            <div className="gap-priority-rows">
              {gapsLoading ? (
                <p className="workspace-loading">Identifying priority gaps...</p>
              ) : gaps.length === 0 ? (
                <p className="workspace-clear">No priority evidence gaps identified.</p>
              ) : (
                gaps.map(gap => (
                  <article className="gap-priority-row" key={`${gap.rank}-${gap.programme_name}`}>
                    <span className="gap-priority-circle">{gap.rank}</span>
                    <div className="gap-priority-text">
                      <h4>{gap.programme_name}</h4>
                      <p className="gap-priority-description">
                        {gap.gap_description} (last: {gap.last_evaluation_year || 'Unknown'}) · {formatRand(gap.total_grant_rand)} invested
                      </p>
                    </div>
                    <a
                      className="generate-tor-button"
                      href={`/tor-generator?programme=${encodeURIComponent(gap.programme_name)}`}
                      onClick={(event) => { event.preventDefault(); navigate(`/tor-generator?programme=${encodeURIComponent(gap.programme_name)}`); }}
                    >
                      Generate TOR →
                    </a>
                  </article>
                ))
              )}
            </div>
          </div>
        </section>

        <section className="alerts-section" aria-label="Intelligence alerts">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Learning Flywheel</p>
              <h2>
                Intelligence Alerts
                <button
                  className="priority-info-trigger"
                  type="button"
                  aria-label="How priority is determined"
                  onClick={() => setPriorityInfoOpen(true)}
                >
                  ⓘ
                </button>
              </h2>
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
            <>
              <div className="alert-grid">
                {(alerts || []).slice(0, 3).map(alert => {
                  const tier = alertTier(alert);
                  return (
                    <article className={`alert-card tier-${tier.toLowerCase()}`} key={alert.id}>
                      <div className="alert-icon" aria-hidden="true">{alertIcons[alert.alert_type] || '📢'}</div>
                      <div>
                        <span className={`alert-tier-badge tier-${tier.toLowerCase()}`}>{ALERT_TIER_LABELS[tier]}</span>
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
                  );
                })}
              </div>
              {alerts.length > 3 && (
                <a className="teal-link earlier-alerts-link" href="/queue" onClick={(event) => { event.preventDefault(); navigate('/queue'); }}>
                  + {alerts.length - 3} earlier alerts in your Workspace →
                </a>
              )}
            </>
          )}
        </section>
        <CascadeFormulaModal item={formulaModal} onClose={() => setFormulaModal(null)} />
        <AlertPriorityInfoModal open={priorityInfoOpen} onClose={() => setPriorityInfoOpen(false)} />
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
                <span>
                  <mark>{record.eqs_tier}</mark>
                  <PathwayBadge pathway={record.eqs_scoring_pathway} />
                </span>
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
  'Which programmes have the strongest evidence?',
  'Where are our biggest evidence gaps?',
  'What should we commission next?',
];

const comparisonFields = [
  {
    field: 'document_type',
    label: 'Document type',
    input: 'select',
    options: ['Impact Evaluation', 'Process Evaluation', 'Implementation Evaluation', 'Research Study', 'Literature Review', 'Annual Report', 'Budget Document'],
  },
  { field: 'evaluation_subtype', label: 'Evaluation subtype', input: 'text' },
  { field: 'eqs_composite', label: 'EQS composite', input: 'number', step: '0.1', min: '1', max: '5' },
  {
    field: 'eqs_tier',
    label: 'EQS tier',
    input: 'select',
    options: ['TIER_1', 'TIER_2', 'TIER_3', 'EXCLUDED', 'N_A'],
  },
  { field: 'key_finding_1', label: 'Key finding 1', input: 'textarea' },
  { field: 'effect_size_composite', label: 'Effect size composite', input: 'number', step: '0.01' },
  {
    field: 'half_life_rating',
    label: 'Half-life rating',
    input: 'select',
    options: ['CURRENT', 'AGING', 'HISTORICAL', 'UNKNOWN'],
  },
];

function comparisonValue(record, field) {
  const value = record?.[field];
  if (value == null) return '';
  return String(value);
}

function buildManualComparison(record) {
  return comparisonFields.reduce((memo, item) => ({
    ...memo,
    [item.field]: comparisonValue(record, item.field),
  }), {});
}

function comparisonMatches(systemValue, manualValue) {
  return String(systemValue ?? '').trim() === String(manualValue ?? '').trim();
}

function SynthesisePage() {
  const user = currentUser();
  const canSynthesise = ['ORGANISATION_LEAD', 'EVIDENCE_ANALYST'].includes(user.role);
  const [selectedRecords, setSelectedRecords] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  const [allRecords, setAllRecords] = useState([]);
  const [selectionExpanded, setSelectionExpanded] = useState(true);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [loading, setLoading] = useState(false);
  const [synthesis, setSynthesis] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ids = (params.get('records') || '').split(',').filter(Boolean).slice(0, 10);
    apiRequest('/api/records')
      .then(all => {
        if (Array.isArray(all)) {
          const normalized = all.map(normalizeRecord);
          setAllRecords(normalized);
          if (ids.length) {
            setSelectedRecords(normalized.filter(r => ids.includes(r.id) || ids.includes(r.adei_record_id)));
          }
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

  const filteredPicker = allRecords.filter(record =>
    !selectedRecords.find(selected => recordId(selected) === recordId(record)) &&
    (
      record.programme_name?.toLowerCase().includes(pickerSearch.toLowerCase()) ||
      record.document_type?.toLowerCase().includes(pickerSearch.toLowerCase())
    )
  );
  const selectedNames = selectedRecords.map(record => record.programme_name).join(', ');

  function addRecord(record) {
    if (selectedRecords.length >= 10) return;
    setSelectedRecords(prev => prev.some(item => recordId(item) === recordId(record)) ? prev : [...prev, record]);
    setShowPicker(false);
    setPickerSearch('');
  }

  function openSourceRecord(id) {
    const record = allRecords.find(item => recordId(item) === id || item.id === id || item.adei_record_id === id)
      || selectedRecords.find(item => recordId(item) === id || item.id === id || item.adei_record_id === id);
    if (record) setSelectedRecord(record);
  }

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
      if (data.success) {
        setSynthesis(data);
        setSelectionExpanded(false);
        setShowPicker(false);
      }
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
          <div>
            <p className="synthesis-step-header">Step 1: Select documents</p>
            {synthesis && !selectionExpanded ? (
              <div className="synthesis-compact-summary">
                <span>Synthesis of {selectedRecords.length} records: {selectedNames}</span>
                <button type="button" onClick={() => setSelectionExpanded(true)}>Edit selection</button>
              </div>
            ) : (
              <>
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
                    <button className="chip-add" type="button" onClick={() => setShowPicker(open => !open)}>
                      + Add document ▾
                    </button>
                  )}
                </div>

                {showPicker && (
                  <div className="synthesis-record-picker">
                    <input
                      className="picker-search"
                      type="search"
                      placeholder="Search classified records"
                      value={pickerSearch}
                      onChange={event => setPickerSearch(event.target.value)}
                    />
                    {filteredPicker.length === 0 ? (
                      <p className="muted">No available records match this search.</p>
                    ) : filteredPicker.slice(0, 30).map(record => (
                      <div className="picker-row" key={recordId(record)}>
                        <div>
                          <span className="picker-row-name">{record.programme_name}</span>
                          <span className="picker-row-meta">{record.eqs_tier} · EQS {record.eqs_composite} · {record.document_type}</span>
                        </div>
                        <button className="picker-add-btn" type="button" onClick={() => addRecord(record)}>
                          + Add
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <p className="synthesis-selection-count">
                  {selectedRecords.length} document{selectedRecords.length !== 1 ? 's' : ''} selected · max 10
                </p>
              </>
            )}
          </div>

          {(!synthesis || selectionExpanded) && (
            <button
              className="btn-primary btn-generate"
              type="button"
              disabled={selectedRecords.length === 0 || loading}
              onClick={handleGenerate}
            >
              {loading ? (
                <span className="button-loading">
                  Analysing {selectedRecords.length} records...
                  <span className="pulse-dot" />
                  <span className="pulse-dot" />
                  <span className="pulse-dot" />
                </span>
              ) : 'Generate Synthesis ▶'}
            </button>
          )}
        </section>

        {error && <div className="synthesis-error">{error}</div>}

        {synthesis && (
          <section className="synthesis-results">
            <div className="synthesis-results-heading">
              <p className="synthesis-step-header">Results</p>
              <h2>Strategic synthesis output</h2>
            </div>
            <div className="synthesis-section">
              <h3>Key Findings</h3>
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
                      <button key={id} type="button" className="source-chip" onClick={() => openSourceRecord(id)}>
                        {id}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </div>

            <div className="synthesis-section">
              <h3>Evidence Gaps</h3>
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
              <h3>Strategic Leverage Points</h3>
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
                <h3>Cross-document Patterns</h3>
                <p className="section-meta">Patterns identified across {synthesis.record_count} records</p>
                {synthesis.cross_patterns.map((p, i) => (
                  <article key={`${p.pattern}-${i}`} className="pattern-card">
                    <p className="pattern-text">{p.pattern}</p>
                    <div className="source-chips">
                      {(p.records_involved || []).map(id => (
                        <button key={id} type="button" className="source-chip" onClick={() => openSourceRecord(id)}>
                          {id}
                        </button>
                      ))}
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
        <RecordDetailModal record={selectedRecord} onClose={() => setSelectedRecord(null)} />
      </section>
    </AppShell>
  );
}

// Matches the "## N. Title" header format the Call 1 prompt requires.
// A plain "N. " check (without the "## " prefix) also matches numbered
// list items inside a section body (deliverables, data access lists,
// etc.), fragmenting the TOR into dozens of false "sections" - the "## "
// requirement plus the strictly-sequential number check below are both
// needed since a body list can coincidentally reach the next expected
// section number too.
const TOR_SECTION_RE = /^##\s+(\d{1,2})\.\s+(.+)$/;

function parseTorSections(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  let expectedNext = 1;
  for (const line of lines) {
    const match = line.match(TOR_SECTION_RE);
    if (match && Number(match[1]) === expectedNext && expectedNext <= 11) {
      if (current) sections.push(current);
      current = { number: match[1], title: match[2].trim(), body: '' };
      expectedNext += 1;
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line;
    }
  }
  if (current) sections.push(current);
  if (!sections.length) return [{ number: '', title: 'Terms of Reference', body: text.trim() }];
  return sections.map(s => ({ ...s, body: s.body.trim() }));
}

const SI_ORDER = ['POLICY_ALIGNMENT', 'SECTOR_WHITE_SPACE', 'ZENEX_ADVANTAGE'];

const SI_CARD_META = {
  POLICY_ALIGNMENT: { label: 'Policy Alignment', tone: 'orange', icon: ShieldCheck },
  SECTOR_WHITE_SPACE: { label: 'Sector White Space', tone: 'teal', icon: Search },
  ZENEX_ADVANTAGE: { label: 'Zenex Advantage', tone: 'purple', icon: TrendingUp },
};

const SI_TIER_LABELS = { high: 'High', moderate: 'Moderate', emerging: 'Emerging' };

function siTier(avg) {
  if (avg >= 7) return 'high';
  if (avg >= 4) return 'moderate';
  return 'emerging';
}

function computeWhyMatters(opportunities) {
  if (!opportunities || !opportunities.length) return null;
  const avg = key => opportunities.reduce((sum, o) => sum + (o.commissioning_priority_score?.[key] || 0), 0) / opportunities.length;
  return {
    strategicFit: siTier(avg('potential_decision_value')),
    evidenceReadiness: siTier(10 - avg('evidence_white_space')),
    zenexAdvantage: siTier(avg('zenex_advantage')),
    policyRelevance: siTier(avg('policy_demand')),
  };
}

function TorGeneratorPage() {
  const user = currentUser();
  const canGenerate = ['ORGANISATION_LEAD', 'EVIDENCE_ANALYST'].includes(user.role);
  const [programmeName, setProgrammeName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [sections, setSections] = useState([]);
  const [expanded, setExpanded] = useState({});
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewSaved, setReviewSaved] = useState(false);
  const [strategicIntelligence, setStrategicIntelligence] = useState(null);
  const [siRefreshing, setSiRefreshing] = useState(false);
  const [dismissedTypes, setDismissedTypes] = useState(new Set());
  const [pendingFocus, setPendingFocus] = useState(null);
  const [progressMessage, setProgressMessage] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setProgrammeName(params.get('programme') || '');
  }, []);

  useEffect(() => {
    if (programmeName) handleGenerate(programmeName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programmeName]);

  if (!canGenerate) {
    return (
      <AppShell active="tor-generator">
        <section className="dashboard-main">
          <article className="empty-panel">
            <LockKeyhole size={28} />
            <h2>TOR generation is not available for this role</h2>
          </article>
        </section>
      </AppShell>
    );
  }

  function applyGenerateResult(data) {
    setResult(data);
    setStrategicIntelligence(data.strategic_intelligence || null);
    setDismissedTypes(new Set());
    const parsed = parseTorSections(data.tor_text);
    setSections(parsed);
    const initialExpanded = {};
    parsed.forEach((_, i) => { initialExpanded[i] = true; });
    setExpanded(initialExpanded);
  }

  function pollJobStatus(jobId) {
    return new Promise(resolve => {
      const startedAt = Date.now();
      const progressTimer = window.setTimeout(() => setProgressMessage('Generating TOR sections...'), 15000);

      const finish = () => { window.clearTimeout(progressTimer); setLoading(false); resolve(); };

      const poll = async () => {
        if (Date.now() - startedAt > 3 * 60 * 1000) {
          setError('This is taking longer than expected. Please try again.');
          finish();
          return;
        }
        try {
          const statusData = await apiRequest(`/api/tor/generate/status/${jobId}`);
          if (statusData.status === 'complete') {
            applyGenerateResult(statusData.result);
            finish();
            return;
          }
          if (statusData.status === 'failed') {
            setError(statusData.error || 'Generation failed. Please try again.');
            finish();
            return;
          }
          window.setTimeout(poll, 3000);
        } catch {
          setError('Unable to check generation status. Please try again.');
          finish();
        }
      };
      poll();
    });
  }

  async function handleGenerate(name, strategicFocus) {
    const targetName = name || programmeName;
    if (!targetName) return;
    setLoading(true);
    setError(null);
    setProgressMessage('Analysing evidence record...');
    try {
      const job = await apiRequest('/api/tor/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          programme_name: targetName,
          ...(strategicFocus ? { strategic_focus: strategicFocus } : {}),
        }),
      });
      await pollJobStatus(job.jobId);
    } catch {
      setError('Unable to generate the Terms of Reference. Please try again.');
      setLoading(false);
    }
  }

  async function handleRefreshStrategicIntelligence() {
    if (!result) return;
    setSiRefreshing(true);
    try {
      const data = await apiRequest('/api/tor/strategic-intelligence/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          programme_name: result.programme_name,
          programme_area: result.programme_area,
        }),
      });
      setStrategicIntelligence(data.strategic_intelligence);
      setDismissedTypes(new Set());
    } catch {
      setError('Unable to refresh strategic intelligence. Please try again.');
    } finally {
      setSiRefreshing(false);
    }
  }

  async function handleDismissOpportunity(opportunityType, title) {
    setDismissedTypes(prev => new Set(prev).add(opportunityType));
    if (!strategicIntelligence?.id) return;
    try {
      await apiRequest(`/api/tor/strategic-intelligence/${strategicIntelligence.id}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunity_type: opportunityType, opportunity_title: title }),
      });
    } catch {
      // Dismissal is best-effort: the card stays hidden for this session
      // even if the audit record failed to save.
    }
  }

  function handleCommissionThis(question) {
    setPendingFocus(question);
  }

  function updateSectionBody(index, value) {
    setSections(prev => prev.map((s, i) => (i === index ? { ...s, body: value } : s)));
  }

  function fullTorText() {
    return sections.map(s => (s.number ? `${s.number}. ${s.title}\n\n${s.body}` : s.body)).join('\n\n');
  }

  async function handleSaveDraft() {
    if (!result) return;
    setDraftSaving(true);
    try {
      await apiRequest('/api/tor/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          programme_name: result.programme_name,
          tor_text: fullTorText(),
          total_investment: result.total_investment,
          evaluation_count: result.evaluation_count,
          gap_type: result.gap_type,
          years_without_endline: result.years_without_endline,
        }),
      });
      setDraftSaved(true);
      window.setTimeout(() => setDraftSaved(false), 3000);
    } catch {
      setError('Unable to save draft. Please try again.');
    } finally {
      setDraftSaving(false);
    }
  }

  async function handleSendForReview() {
    if (!result) return;
    setReviewSaving(true);
    try {
      await apiRequest('/api/tor/submit-for-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          programme_name: result.programme_name,
          tor_text: fullTorText(),
          total_investment: result.total_investment,
          evaluation_count: result.evaluation_count,
          gap_type: result.gap_type,
          years_without_endline: result.years_without_endline,
        }),
      });
      setReviewSaved(true);
      window.setTimeout(() => setReviewSaved(false), 3000);
    } catch {
      setError('Unable to send for review. Please try again.');
    } finally {
      setReviewSaving(false);
    }
  }

  function handleDownloadWord() {
    if (!result) return;
    const html = fullTorText()
      .split('\n\n')
      .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('\n');
    downloadWord(`TOR-${result.programme_name.replace(/\s+/g, '-')}.doc`, html);
  }

  return (
    <AppShell active="tor-generator">
      <section className="dashboard-main tor-generator-page">
        <header className="dashboard-header page-header tor-generator-header">
          <div>
            <p className="eyebrow">Terms of Reference</p>
            <h1>{result?.programme_name || programmeName || 'Terms of Reference Generator'}</h1>
            {result && (
              <p className="page-subheader">
                Generated from {result.evaluation_count} evaluation{result.evaluation_count !== 1 ? 's' : ''} in the Zenex corpus
                {' · '}Total investment: {formatRand(result.total_investment)}
              </p>
            )}
          </div>
          <div className="tor-generator-actions">
            <button
              className="btn-secondary"
              type="button"
              disabled={loading}
              onClick={() => { handleGenerate(programmeName, pendingFocus); setPendingFocus(null); }}
            >
              {loading ? 'Regenerating...' : pendingFocus ? 'Regenerate with focus' : 'Regenerate'}
            </button>
            <button className="btn-secondary" type="button" disabled={!result} onClick={handleDownloadWord}>
              <Download size={16} />
              <span>Download Word</span>
            </button>
            <button className="btn-primary" type="button" disabled={!result || reviewSaving} onClick={handleSendForReview}>
              {reviewSaved ? 'Sent to Workspace' : reviewSaving ? 'Sending...' : 'Save to Workspace'}
            </button>
          </div>
        </header>

        {error && <div className="synthesis-error">{error}</div>}

        {pendingFocus && (
          <div className="tor-commission-note">
            <span>Commissioning focus added: &ldquo;{pendingFocus}&rdquo;; click Regenerate to incorporate it into the TOR.</span>
            <button type="button" onClick={() => setPendingFocus(null)}>Clear</button>
          </div>
        )}

        {loading && !result && (
          <p className="workspace-loading">{progressMessage || `Drafting Terms of Reference for ${programmeName}...`}</p>
        )}

        {result && (
          <section className="tor-panel tor-brief-section">
            <p className="eyebrow">Section 1 · Evaluation Brief</p>
            <h2>Evaluation Brief</h2>
            <div className="tor-brief-grid">
              <div>
                <p className="tor-brief-label">Programme</p>
                <p className="tor-brief-value">{result.programme_name}</p>
              </div>
              <div>
                <p className="tor-brief-label">Programme area</p>
                <p className="tor-brief-value">{result.programme_area || 'Not recorded'}</p>
              </div>
              <div>
                <p className="tor-brief-label">Evidence gap</p>
                <p className="tor-brief-value">{result.gap_type === 'no_endline' ? 'No endline evaluation' : 'No impact evaluation'}</p>
              </div>
              <div>
                <p className="tor-brief-label">Total investment</p>
                <p className="tor-brief-value">{formatRand(result.total_investment)}</p>
              </div>
              <div>
                <p className="tor-brief-label">Last evaluation</p>
                <p className="tor-brief-value">{result.last_evaluation_year || 'Unknown'}</p>
              </div>
            </div>
          </section>
        )}

        {result && (
          <section className="tor-panel tor-evidence-section">
            <p className="eyebrow">Section 2 · Evidence Base</p>
            <h2>Evidence Base</h2>
            <p className="section-meta">
              {result.evaluation_count} prior evaluation{result.evaluation_count !== 1 ? 's' : ''} drawn from the Zenex corpus
            </p>
            <div className="tor-evidence-grid">
              {(result.source_records || []).map(r => (
                <article key={r.id} className="tor-source-card">
                  <div className="tor-source-header">
                    <span>{r.year}</span>
                    <span className={`confidence-badge ${String(r.eqs_tier || '').toLowerCase()}`}>{r.eqs_tier}</span>
                  </div>
                  <p className="tor-source-type">{r.document_type}{r.eqs_composite ? ` · EQS ${r.eqs_composite}/5.0` : ''}</p>
                  {r.key_finding_1 && <p className="tor-source-finding">{r.key_finding_1}</p>}
                  {r.original_filename && <p className="tor-source-file">{r.original_filename}</p>}
                </article>
              ))}
            </div>
          </section>
        )}

        {result && (
          <section className="tor-panel tor-body-section">
            <p className="eyebrow">Section 3 · Terms of Reference</p>
            <h2>Terms of Reference</h2>
            <div className="tor-generator-main">
              {sections.map((section, i) => {
                const flagged = section.body.includes('[REVIEW]');
                const isOpen = expanded[i] !== false;
                return (
                  <article key={`${section.number}-${section.title}`} className={`tor-section-card${flagged ? ' tor-section-flagged' : ''}`}>
                    <button
                      type="button"
                      className="tor-section-toggle"
                      onClick={() => setExpanded(prev => ({ ...prev, [i]: !isOpen }))}
                    >
                      <span className="tor-section-title">
                        {section.number ? `${section.number}. ` : ''}{section.title}
                      </span>
                      {flagged && <span className="tor-review-badge">REVIEW</span>}
                      <span className="tor-section-caret">{isOpen ? '▾' : '▸'}</span>
                    </button>
                    {isOpen && (
                      <textarea
                        className="tor-section-body"
                        value={section.body}
                        onChange={event => updateSectionBody(i, event.target.value)}
                        rows={Math.max(4, Math.ceil(section.body.length / 90))}
                      />
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {strategicIntelligence && (() => {
          const visibleOpportunities = SI_ORDER
            .map(type => (strategicIntelligence.opportunities || []).find(o => o.opportunity_type === type))
            .filter(o => o && !dismissedTypes.has(o.opportunity_type));
          const whyMatters = computeWhyMatters(strategicIntelligence.opportunities);

          return (
            <section className="tor-panel tor-strategic-section">
              <div className="tor-strategic-heading">
                <div>
                  <p className="eyebrow">Section 4 · Strategic Intelligence</p>
                  <h2>What the sector does not yet know</h2>
                  <p className="section-meta">
                    Powered by real-time strategy alignment. Refreshes on generation.
                    {strategicIntelligence.generated_at && ` Last refreshed ${new Date(strategicIntelligence.generated_at).toLocaleString('en-ZA')}.`}
                  </p>
                </div>
                <button className="btn-secondary" type="button" disabled={siRefreshing} onClick={handleRefreshStrategicIntelligence}>
                  {siRefreshing ? 'Refreshing...' : 'Refresh strategic intelligence'}
                </button>
              </div>

              {strategicIntelligence.error && <div className="synthesis-error">{strategicIntelligence.error}</div>}

              {visibleOpportunities.length > 0 && (
                <>
                  <div className="tor-strategic-cards">
                    {visibleOpportunities.map(opp => {
                      const meta = SI_CARD_META[opp.opportunity_type];
                      const Icon = meta.icon;
                      return (
                        <article key={opp.opportunity_type} className={`tor-strategic-card tor-strategic-${meta.tone}`}>
                          <button
                            type="button"
                            className="tor-strategic-dismiss"
                            aria-label={`Dismiss ${meta.label}`}
                            onClick={() => handleDismissOpportunity(opp.opportunity_type, opp.title)}
                          >
                            <X size={14} />
                          </button>
                          <div className="tor-strategic-card-head">
                            <Icon size={20} />
                            <span className="tor-strategic-label">{meta.label}</span>
                            <span className={`confidence-badge ${String(opp.confidence || '').toLowerCase()}`}>{opp.confidence}</span>
                          </div>
                          <h4 className="tor-strategic-title">{opp.title}</h4>
                          <p className="tor-strategic-question">{opp.question}</p>
                          <p className="tor-strategic-context">{opp.context}</p>
                          <p className="tor-strategic-suggestion">
                            <strong>Commission this:</strong> {opp.commissioning_suggestion}
                          </p>
                          {opp.sources.length > 0 && (
                            <p className="tor-strategic-sources">
                              Source:{' '}
                              {opp.sources.map((s, i) => (
                                <React.Fragment key={s.url}>
                                  {i > 0 && ', '}
                                  <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
                                </React.Fragment>
                              ))}
                            </p>
                          )}
                          <button type="button" className="tor-strategic-commission" onClick={() => handleCommissionThis(opp.question)}>
                            Commission this →
                          </button>
                        </article>
                      );
                    })}
                  </div>

                  {whyMatters && (
                    <div className="tor-why-matters">
                      <h3>Why this matters</h3>
                      <div className="tor-why-matters-grid">
                        <div>
                          <p className="tor-why-label">Strategic fit</p>
                          <p className={`tor-why-value tor-why-${whyMatters.strategicFit}`}>{SI_TIER_LABELS[whyMatters.strategicFit]}</p>
                        </div>
                        <div>
                          <p className="tor-why-label">Evidence readiness</p>
                          <p className={`tor-why-value tor-why-${whyMatters.evidenceReadiness}`}>{SI_TIER_LABELS[whyMatters.evidenceReadiness]}</p>
                        </div>
                        <div>
                          <p className="tor-why-label">Zenex advantage</p>
                          <p className={`tor-why-value tor-why-${whyMatters.zenexAdvantage}`}>{SI_TIER_LABELS[whyMatters.zenexAdvantage]}</p>
                        </div>
                        <div>
                          <p className="tor-why-label">Policy relevance</p>
                          <p className={`tor-why-value tor-why-${whyMatters.policyRelevance}`}>{SI_TIER_LABELS[whyMatters.policyRelevance]}</p>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {visibleOpportunities.length === 0 && !strategicIntelligence.error && (
                <p className="workspace-clear">No strategic intelligence opportunities to show.</p>
              )}
            </section>
          );
        })()}

        {result && (
          <div className="tor-generator-bottom-actions">
            <button className="btn-secondary" type="button" onClick={handleDownloadWord}>
              <Download size={16} />
              <span>Download as Word Document</span>
            </button>
            <button className="btn-primary" type="button" disabled={reviewSaving} onClick={handleSendForReview}>
              {reviewSaved ? 'Sent for Review' : reviewSaving ? 'Sending...' : 'Send to Fatima for Review'}
            </button>
            <button className="btn-secondary" type="button" disabled={draftSaving} onClick={handleSaveDraft}>
              {draftSaved ? 'Draft Saved' : draftSaving ? 'Saving...' : 'Save Draft'}
            </button>
          </div>
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
  const [supportOpen, setSupportOpen] = useState(true);
  const [estateCount, setEstateCount] = useState(0);
  const canAsk = ['ORGANISATION_LEAD', 'EVIDENCE_ANALYST'].includes(user.role);

  const supportingRecords = useMemo(() => {
    const ids = result?.supporting_record_ids || [];
    return ids
      .map(id => records.find(record => recordId(record) === id || record.id === id))
      .filter(Boolean);
  }, [records, result]);
  const searchRecordCount = estateCount || records.length;
  const hasContradiction = hasRealContradiction(result?.contradictions);

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/stats/estate')
      .then(data => {
        if (!cancelled) setEstateCount(data?.total_records || 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function submitAsk(prompt = question) {
    const clean = String(prompt || '').trim();
    if (!clean || loading) return;
    setQuestion(clean);
    setLoading(true);
    setError(false);
    setResult(null);
    setSupportOpen(true);
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
            <p>Search {searchRecordCount} classified intelligence records</p>
          </div>
        </header>

        {searchRecordCount < 5 && (
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
              <button type="button" key={prompt} onClick={() => {
                setQuestion(prompt);
                submitAsk(prompt);
              }}>{prompt}</button>
            ))}
          </section>
        )}

        {loading && (
          <section className="pulse-loading">
            <span className="pulse-dot" />
            <span className="pulse-dot" />
            <span className="pulse-dot" />
            <strong>Searching {searchRecordCount} records...</strong>
          </section>
        )}

        {error && (
          <article className="error-banner">Unable to search the corpus right now. Please try again in a moment.</article>
        )}

        {result && (
          <section className="ask-results">
            <div className="ask-result-meta">
              <span className={`confidence-badge ${String(result.confidence || 'LOW').toLowerCase()}`}>{result.confidence}</span>
              <span>Searched {result.records_searched || searchRecordCount} records · {dateTimeStamp(result.generated_at)}</span>
            </div>

            <article className="ask-answer-card">
              <h2>Answer</h2>
              <div
                className="ask-answer-body"
                dangerouslySetInnerHTML={{ __html: safeRenderMarkdown(result.answer) }}
              />
            </article>

            {(supportingRecords.length > 0 || result.supporting_record_ids?.length > 0) && (
              <section className="ask-supporting-records">
                <button className="ask-supporting-toggle" type="button" onClick={() => setSupportOpen(open => !open)}>
                  Based on these records ({supportingRecords.length || result.supporting_record_ids?.length || 0})
                </button>
                {supportOpen && (
                  <div className="source-chips ask-source-chips">
                    {supportingRecords.map(record => (
                      <button className="source-chip" type="button" key={recordId(record)} onClick={() => setSelectedRecord(record)}>
                        {record.programme_name} · {record.eqs_tier} · {record.year || record.publication_year}
                      </button>
                    ))}
                    {supportingRecords.length === 0 && (result.supporting_record_ids || []).map(id => (
                      <button className="source-chip" type="button" key={id}>
                        {id}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}

            {hasContradiction && (
              <article className="ask-contradiction-box">
                <strong>⚠ Contradictory evidence found</strong>
                <p>{sanitiseAnswer(result.contradictions)}</p>
              </article>
            )}

            <article className="ask-recommendation-box">
              <strong>Recommended action</strong>
              <p>{sanitiseAnswer(result.recommended_action)}</p>
            </article>
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
  const [classifyPhaseIdx, setClassifyPhaseIdx] = useState(-1);
  const [classificationResult, setClassificationResult] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadPhase, setUploadPhase] = useState('idle');
  const [duplicateInfo, setDuplicateInfo] = useState(null);
  const [classifiedRecord, setClassifiedRecord] = useState(null);
  const [manualComparison, setManualComparison] = useState({});
  const [comparisonSubmitting, setComparisonSubmitting] = useState(false);
  const [comparisonSubmitted, setComparisonSubmitted] = useState(false);
  const classifyTimersRef = useRef([]);

  function clearClassifyTimers() {
    classifyTimersRef.current.forEach(id => window.clearTimeout(id));
    classifyTimersRef.current = [];
  }

  useEffect(() => () => clearClassifyTimers(), []);

  function resetForm() {
    clearClassifyTimers();
    setSelectedFile(null);
    setDriveFileId('');
    setClassifyPhaseIdx(-1);
    setClassificationResult('');
    setUploadProgress(0);
    setUploadPhase('idle');
    setDuplicateInfo(null);
    setClassifiedRecord(null);
    setManualComparison({});
    setComparisonSubmitted(false);
  }

  async function uploadAndClassify(file) {
    if (!file) return null;
    clearClassifyTimers();
    setSelectedFile(file);
    setClassifyPhaseIdx(-1);
    setClassificationResult('');
    setDuplicateInfo(null);
    setClassifiedRecord(null);
    setManualComparison({});
    setComparisonSubmitted(false);
    setUploadPhase('requesting');
    setUploadProgress(0);

    try {
      const presign = await apiRequest(`/api/classify/presign?${new URLSearchParams({
        filename: file.name,
        content_type: file.type || 'application/octet-stream',
      })}`);

      if (!presign?.upload_url || !presign?.s3_key) {
        throw new Error('Could not prepare upload');
      }

      setUploadPhase('uploading');

      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            setUploadProgress(Math.round((event.loaded / event.total) * 100));
          }
        });

        xhr.addEventListener('load', () => {
          if (xhr.status === 200 || xhr.status === 204) resolve();
          else reject(new Error(`Upload failed: ${xhr.status}`));
        });
        xhr.addEventListener('error', () => reject(new Error('Network error')));
        xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

        xhr.open('PUT', presign.upload_url);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.send(file);
      });

      setUploadProgress(100);
      setUploadPhase('classifying');
      classifyTimersRef.current = CLASSIFY_PHASES.map((phase, index) =>
        window.setTimeout(() => setClassifyPhaseIdx(index), phase.delay)
      );

      const result = await apiRequest('/api/classify/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          s3_key: presign.s3_key,
          filename: file.name,
          institution: tenantConfig.orgName,
        }),
      });

      if (result?.success || result?.record_id) {
        let record = result;
        if (result.record_id) {
          try {
            record = await apiRequest(`/api/records/${result.record_id}`);
          } catch {
            record = result;
          }
        }
        clearClassifyTimers();
        setClassifiedRecord(record);
        setManualComparison(buildManualComparison(record));
        setUploadPhase('complete');
        setClassificationResult(`Created ${result.record_id || result.filename}`);
        return result;
      }

      throw new Error(result?.error || 'Classification failed');
    } catch (err) {
      clearClassifyTimers();
      if (err.status === 409 && err.payload?.error === 'duplicate_detected') {
        setDuplicateInfo(err.payload);
        setUploadPhase('duplicate');
        setClassificationResult(err.payload.message || 'Document already exists');
        return null;
      }
      setUploadPhase('error');
      setClassificationResult(err.message || 'Upload failed');
      console.error('Upload error:', err);
      throw err;
    }
  }

  async function startPipeline() {
    setClassificationResult('');

    if (selectedFile) {
      try {
        await uploadAndClassify(selectedFile);
      } catch (error) {
        setClassificationResult(`Upload failed: ${error.message}`);
      }
    } else if (driveFileId.trim()) {
      setClassificationResult('Drive file ID fallback is captured, but live classification now requires S3 upload.');
    }
  }

  async function handleFile(file) {
    if (!file) return;
    try {
      await uploadAndClassify(file);
    } catch {
      // User-facing state is set in uploadAndClassify.
    }
  }

  async function submitComparisonFeedback() {
    if (!classifiedRecord) return;
    setComparisonSubmitting(true);
    try {
      const systemValues = comparisonFields.reduce((memo, item) => ({
        ...memo,
        [item.field]: comparisonValue(classifiedRecord, item.field),
      }), {});
      await apiRequest('/api/classify/comparison-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          record_id: classifiedRecord.id || classifiedRecord.record_id || classifiedRecord.adei_record_id,
          system_values: systemValues,
          manual_values: manualComparison,
        }),
      });
      setComparisonSubmitted(true);
    } finally {
      setComparisonSubmitting(false);
    }
  }

  const isComplete = uploadPhase === 'complete';
  const isRunning = ['requesting', 'uploading', 'classifying'].includes(uploadPhase);
  const canStart = driveFileId.trim() || (selectedFile && ['idle', 'error', 'duplicate'].includes(uploadPhase));
  const currentClassifyPhase = classifyPhaseIdx >= 0 ? CLASSIFY_PHASES[classifyPhaseIdx] : null;
  const recordId = classifiedRecord?.id || classifiedRecord?.record_id || classifiedRecord?.adei_record_id || '';
  const eqsTierDisplay = formatEqsTier(classifiedRecord?.eqs_tier || classifiedRecord?.confidence_tier);
  const eqsCompositeDisplay = classifiedRecord?.eqs_composite != null
    ? `${Number(classifiedRecord.eqs_composite).toFixed(2)}/5.0`
    : 'N/A';
  const needsOcr = classifiedRecord?.extraction_quality === 'NEEDS_OCR';

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
              {uploadPhase === 'idle' && (
                <p className="upload-hint">
                  Drop PDF, Word, or PowerPoint files here. Any file size accepted.
                </p>
              )}
              {uploadPhase === 'requesting' && (
                <div className="pulse-loading">
                  <span className="pulse-dot" />
                  <span className="pulse-dot" />
                  <span className="pulse-dot" />
                  <span>Preparing secure upload...</span>
                </div>
              )}
              {uploadPhase === 'uploading' && (
                <div className="upload-progress-container">
                  <div className="upload-progress-bar">
                    <div
                      className="upload-progress-fill"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                  <p className="upload-progress-label">
                    {uploadProgress}% uploaded to secure storage
                  </p>
                </div>
              )}
              {uploadPhase === 'classifying' && (
                <div className="upload-progress-container">
                  <div className="upload-progress-bar">
                    <div
                      className="upload-progress-fill"
                      style={{ width: `${currentClassifyPhase ? currentClassifyPhase.pct : 10}%` }}
                    />
                  </div>
                  <p className="upload-progress-label">
                    {currentClassifyPhase ? currentClassifyPhase.label : 'Uploading document...'}
                  </p>
                  {currentClassifyPhase?.subtext && (
                    <p className="upload-progress-subtext">{currentClassifyPhase.subtext}</p>
                  )}
                </div>
              )}
              {uploadPhase === 'complete' && needsOcr && (
                <div className="upload-warning-ocr">
                  <span className="duplicate-icon">⚠</span>
                  <p>
                    This document appears to be a scanned image. Text extraction quality may be reduced.
                    Classification has been completed with available text but some fields may be incomplete.
                    Consider uploading a text-searchable version for more accurate results.
                  </p>
                </div>
              )}
              {uploadPhase === 'complete' && (
                <div className="upload-success">
                  <p className="upload-success-headline">
                    {classifiedRecord?.programme_name || 'Document'} classified successfully.
                  </p>
                  <p className="upload-success-eqs">{eqsTierDisplay} ({eqsCompositeDisplay})</p>
                  <div className="upload-success-actions">
                    <a className="btn-ghost" href={`/records?record=${encodeURIComponent(recordId)}`}>
                      View Record <ArrowRight size={16} />
                    </a>
                    <button type="button" className="secondary-action" onClick={resetForm}>
                      Upload Another Document
                    </button>
                  </div>
                </div>
              )}
              {uploadPhase === 'error' && (
                <div className="upload-error">
                  Upload failed. Please try again or contact your system administrator.
                </div>
              )}
              {uploadPhase === 'duplicate' && duplicateInfo && (
                <div className="upload-duplicate">
                  <span className="duplicate-icon">⚠</span>
                  <div>
                    <strong>Document already exists</strong>
                    <p>
                      This document is already in the archive. View the existing record in the Library or upload a revised version with a different filename.
                    </p>
                    <a href="/records" className="btn-ghost">
                      View in Library
                    </a>
                  </div>
                </div>
              )}
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
                    setClassifyPhaseIdx(-1);
                  }}
                />
                <span>Legacy intake only</span>
              </div>
            </div>

            <button className="primary-action classify-action" type="button" disabled={!canStart} onClick={startPipeline}>
              <span>{isComplete ? 'Classification Complete' : uploadPhase === 'error' ? 'Try Again' : 'Start Classification'}</span>
              <ArrowRight size={18} />
            </button>
          </article>

          <article className="pipeline-panel">
            <div className="panel-title">
              <Clock3 size={20} />
              <span>Classification pipeline</span>
            </div>

            <div className="pipeline-list">
              {CLASSIFY_PHASES.map((phase, index) => {
                const complete = classifyPhaseIdx > index || isComplete;
                const active = classifyPhaseIdx === index && !isComplete;
                return (
                  <div className={`pipeline-step ${complete ? 'complete' : ''} ${active ? 'active' : ''}`} key={phase.label}>
                    <div>{complete ? <CheckCircle2 size={16} /> : <span>{index + 1}</span>}</div>
                    <p>{phase.label}</p>
                  </div>
                );
              })}
            </div>

            <div className="pipeline-result">
              <p className="eyebrow">Pipeline state</p>
              <strong>{isComplete ? 'Record ready for Evidence Library' : isRunning ? 'Classification running' : 'Waiting for document'}</strong>
              <span>{classificationResult || (isComplete ? 'Expert queue and EQS outputs are prepared for review.' : 'Progress updates will stream here from the live API.')}</span>
            </div>

            {classifiedRecord && isComplete && (
              <section className="classification-comparison">
                <div className="comparison-heading">
                  <p className="eyebrow">Classification comparison</p>
                  <h2>System classification vs your assessment</h2>
                </div>
                <div className="comparison-table" role="table">
                  <div className="comparison-row comparison-head" role="row">
                    <span>Field</span>
                    <span>System Value</span>
                    <span>Your Assessment</span>
                    <span>Match</span>
                  </div>
                  {comparisonFields.map(item => {
                    const systemValue = comparisonValue(classifiedRecord, item.field);
                    const manualValue = manualComparison[item.field] ?? '';
                    const matches = comparisonMatches(systemValue, manualValue);
                    return (
                      <div className="comparison-row" role="row" key={item.field}>
                        <span>{item.label}</span>
                        <span>{systemValue || 'Not recorded'}</span>
                        <span>
                          {item.input === 'select' ? (
                            <select
                              value={manualValue}
                              onChange={event => setManualComparison(current => ({ ...current, [item.field]: event.target.value }))}
                            >
                              <option value="">Not recorded</option>
                              {item.options.map(option => (
                                <option key={option} value={option}>{option}</option>
                              ))}
                            </select>
                          ) : item.input === 'textarea' ? (
                            <textarea
                              value={manualValue}
                              onChange={event => setManualComparison(current => ({ ...current, [item.field]: event.target.value }))}
                            />
                          ) : (
                            <input
                              type={item.input}
                              step={item.step}
                              min={item.min}
                              max={item.max}
                              value={manualValue}
                              onChange={event => setManualComparison(current => ({ ...current, [item.field]: event.target.value }))}
                            />
                          )}
                        </span>
                        <span className={matches ? 'comparison-match' : 'comparison-diff'}>
                          {matches ? '✓' : '≠'}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <button
                  className="primary-action comparison-submit"
                  type="button"
                  onClick={submitComparisonFeedback}
                  disabled={comparisonSubmitting || comparisonSubmitted}
                >
                  <span>{comparisonSubmitted ? 'Comparison feedback submitted' : comparisonSubmitting ? 'Submitting...' : 'Submit comparison feedback'}</span>
                </button>
              </section>
            )}
          </article>
        </section>
      </section>
    </AppShell>
  );
}

function formatRand(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'R0';
  return `R${num >= 1000000 ? `${(num / 1000000).toFixed(1)}m` : num.toLocaleString()}`;
}

const WORKSPACE_LOSS_FRAMING = {
  methodology_description: "Without a methodology description, this evaluation can't be cited as rigorous evidence.",
  null_findings_reported: "Unreported null findings break Protocol Amendment 1; this record can't be board-cited until confirmed.",
  limitations: "Undocumented limitations mean this finding can't be defended under scrutiny.",
  effect_size_composite: "No effect size recorded; this evaluation can't support an impact claim.",
  sample_size_learners: "No sample size recorded; this evaluation can't be weighted against comparable studies.",
  baseline_available: "Baseline availability is unconfirmed; causal claims can't be verified.",
  endline_available: "Endline availability is unconfirmed; the evidence chain is incomplete.",
  commissioning_standards_met: "Commissioning standards are unconfirmed; this record is excluded from the EROI score.",
  total_cost_rand: 'No cost recorded; this programme is invisible to Financial Capital.',
  cost_data_source: "No cost data source recorded; this figure can't be trusted for SROI.",
  cost_per_learner: "No per-learner cost; this programme can't be benchmarked for cost-effectiveness.",
  financial_year: "No financial year recorded; this cost figure can't be placed in context.",
};

function workspaceLossFraming(field, label) {
  return WORKSPACE_LOSS_FRAMING[field] || `Missing ${(label || field).toLowerCase()}; this record is incomplete.`;
}

function WorkspaceFieldEditor({ recordId, entry, onSave }) {
  const [value, setValue] = useState(entry.suggested_value ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(finalValue) {
    setSaving(true);
    setError('');
    try {
      await onSave(recordId, entry.field, finalValue);
    } catch (err) {
      setError(err.payload?.error || err.message || 'Could not save.');
      setSaving(false);
    }
  }

  if (entry.type === 'boolean') {
    return (
      <div className="workspace-field-editor">
        <div className="workspace-field-radios">
          <label>
            <input type="radio" name={`${recordId}-${entry.field}`} checked={value === true} onChange={() => setValue(true)} />
            <span>Yes</span>
          </label>
          <label>
            <input type="radio" name={`${recordId}-${entry.field}`} checked={value === false} onChange={() => setValue(false)} />
            <span>No</span>
          </label>
        </div>
        <button className="secondary-action" type="button" disabled={value === '' || saving} onClick={() => submit(value)}>
          {saving ? 'Saving...' : 'Save'}
        </button>
        {error && <span className="workspace-field-error">{error}</span>}
      </div>
    );
  }

  if (entry.type === 'enum') {
    return (
      <div className="workspace-field-editor">
        <div className="workspace-field-radios">
          {entry.options.map(option => (
            <label key={option}>
              <input type="radio" name={`${recordId}-${entry.field}`} checked={value === option} onChange={() => setValue(option)} />
              <span>{option.replace(/_/g, ' ')}</span>
            </label>
          ))}
        </div>
        <button className="secondary-action" type="button" disabled={!value || saving} onClick={() => submit(value)}>
          {saving ? 'Saving...' : 'Save'}
        </button>
        {error && <span className="workspace-field-error">{error}</span>}
      </div>
    );
  }

  if (entry.type === 'number') {
    return (
      <div className="workspace-field-editor">
        <input
          type="number"
          value={value}
          onChange={event => setValue(event.target.value)}
          placeholder={`Enter ${(entry.label || entry.field).toLowerCase()}`}
        />
        <button className="secondary-action" type="button" disabled={value === '' || saving} onClick={() => submit(value)}>
          {saving ? 'Saving...' : 'Save'}
        </button>
        {error && <span className="workspace-field-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="workspace-field-editor">
      {entry.multiline ? (
        <textarea
          rows={3}
          value={value}
          onChange={event => setValue(event.target.value)}
          placeholder={`Enter ${(entry.label || entry.field).toLowerCase()}`}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={event => setValue(event.target.value)}
          placeholder={`Enter ${(entry.label || entry.field).toLowerCase()}`}
        />
      )}
      <button className="secondary-action" type="button" disabled={!value || saving} onClick={() => submit(value)}>
        {saving ? 'Saving...' : 'Save'}
      </button>
      {error && <span className="workspace-field-error">{error}</span>}
    </div>
  );
}

function WorkspaceGapCard({ gap, onSaveField }) {
  return (
    <article className="workspace-gap-card">
      <div className="workspace-gap-card-header">
        <div>
          <p className="eyebrow">{gap.document_type || 'Evidence record'}</p>
          <h3>{gap.programme_name || gap.record_id}</h3>
        </div>
        <span className="workspace-gap-count">{gap.missing_fields.length} missing</span>
      </div>
      <div className="workspace-gap-fields">
        {gap.missing_fields.map(entry => (
          <div className="workspace-gap-field" key={entry.field}>
            <p className="workspace-loss-framing">{workspaceLossFraming(entry.field, entry.label)}</p>
            {entry.suggested_value != null && (
              <p className="workspace-suggestion">
                Suggested from {entry.suggested_source}: <strong>{String(entry.suggested_value)}</strong>
              </p>
            )}
            <WorkspaceFieldEditor recordId={gap.record_id} entry={entry} onSave={onSaveField} />
          </div>
        ))}
      </div>
    </article>
  );
}

function WorkspaceFinancialCard({ item, onConfirm, onMarkUnknown }) {
  const [mode, setMode] = useState('view');
  const [customValue, setCustomValue] = useState(item.suggested_value ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const validSources = ['AUDITED', 'GRANT_AGREEMENT', 'MANAGEMENT_ACCOUNTS', 'PROXY', 'UNKNOWN'];

  async function handleConfirm() {
    setBusy(true);
    setError('');
    try {
      await onConfirm(item.record_id, item.suggested_value, validSources.includes(item.source) ? item.source : undefined);
    } catch (err) {
      setError(err.payload?.error || err.message || 'Could not confirm.');
      setBusy(false);
    }
  }

  async function handleSubmitDifferent() {
    setBusy(true);
    setError('');
    try {
      await onConfirm(item.record_id, customValue, undefined);
    } catch (err) {
      setError(err.payload?.error || err.message || 'Could not save.');
      setBusy(false);
    }
  }

  async function handleUnknown() {
    setBusy(true);
    setError('');
    try {
      await onMarkUnknown(item.record_id);
    } catch (err) {
      setError(err.payload?.error || err.message || 'Could not update.');
      setBusy(false);
    }
  }

  return (
    <article className="workspace-financial-card">
      <div className="workspace-gap-card-header">
        <div>
          <p className="eyebrow">{item.document_type || 'Evidence record'}</p>
          <h3>{item.programme_name || item.record_id}</h3>
        </div>
        <span className="workspace-financial-value">{formatRand(item.suggested_value)}</span>
      </div>
      <p className="workspace-suggestion">
        Suggested value from <strong>{item.source || 'document extraction'}</strong>
        {item.financial_year ? ` · ${item.financial_year}` : ''}
      </p>

      {mode === 'view' ? (
        <div className="workspace-financial-actions">
          <button className="secondary-action confirm" type="button" disabled={busy} onClick={handleConfirm}>
            <Check size={16} />
            <span>Confirm {formatRand(item.suggested_value)}</span>
          </button>
          <button className="secondary-action" type="button" disabled={busy} onClick={() => setMode('different')}>
            <Edit3 size={16} />
            <span>Enter different value</span>
          </button>
          <button className="secondary-action" type="button" disabled={busy} onClick={handleUnknown}>
            <span>Mark as unknown</span>
          </button>
        </div>
      ) : (
        <div className="workspace-financial-actions">
          <input
            type="number"
            value={customValue}
            onChange={event => setCustomValue(event.target.value)}
            placeholder="Enter correct total (R)"
          />
          <button className="secondary-action confirm" type="button" disabled={busy || customValue === ''} onClick={handleSubmitDifferent}>
            <Check size={16} />
            <span>Save</span>
          </button>
          <button className="secondary-action" type="button" disabled={busy} onClick={() => setMode('view')}>
            <span>Cancel</span>
          </button>
        </div>
      )}

      {error && <p className="workspace-field-error">{error}</p>}
    </article>
  );
}

function WorkspacePage() {
  const [queueItems, setQueueItems] = useState(FALLBACK_QUEUE_EMPTY);
  const [queueLoading, setQueueLoading] = useState(true);
  const [overrideValues, setOverrideValues] = useState({});
  const [completeness, setCompleteness] = useState(null);
  const [completenessLoading, setCompletenessLoading] = useState(true);
  const [financial, setFinancial] = useState(null);
  const [financialLoading, setFinancialLoading] = useState(true);
  const { alerts, loading: alertsLoading, markRead } = useAlerts();

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/queue')
      .then(data => {
        if (!cancelled && Array.isArray(data)) setQueueItems(data.map(normalizeQueueItem));
      })
      .catch(() => {
        if (!cancelled) setQueueItems(FALLBACK_QUEUE_EMPTY);
      })
      .finally(() => {
        if (!cancelled) setQueueLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/stats/completeness')
      .then(data => {
        if (!cancelled) setCompleteness(data);
      })
      .catch(() => {
        if (!cancelled) setCompleteness(null);
      })
      .finally(() => {
        if (!cancelled) setCompletenessLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiRequest('/api/financial/unconfirmed')
      .then(data => {
        if (!cancelled) setFinancial(data);
      })
      .catch(() => {
        if (!cancelled) setFinancial(null);
      })
      .finally(() => {
        if (!cancelled) setFinancialLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function resolveQueueItem(id, value, override = false) {
    const item = queueItems.find(entry => entry.id === id);
    setQueueItems(current => current.filter(entry => entry.id !== id));
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

  function skipQueueItem(id) {
    // Snooze only - no DB write, same as before. It will resurface next visit.
    setQueueItems(current => current.filter(entry => entry.id !== id));
  }

  async function saveCorpusField(recordId, field, value) {
    await apiRequest(`/api/records/${recordId}/field`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, value }),
    });
    setCompleteness(current => {
      if (!current) return current;
      const stripField = gaps => gaps
        .map(gap => (gap.record_id === recordId
          ? { ...gap, missing_fields: gap.missing_fields.filter(entry => entry.field !== field) }
          : gap))
        .filter(gap => gap.missing_fields.length > 0);
      const nextCritical = stripField(current.critical_gaps);
      const nextFinancial = stripField(current.financial_gaps);
      return {
        ...current,
        critical_gaps: nextCritical,
        financial_gaps: nextFinancial,
        critical_gaps_count: nextCritical.length,
        financial_gaps_count: nextFinancial.length,
      };
    });
  }

  async function confirmFinancial(recordId, value, source) {
    await apiRequest(`/api/records/${recordId}/field`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field: 'total_cost_rand', value, source }),
    });
    setFinancial(current => {
      if (!current) return current;
      const items = current.items.filter(item => item.record_id !== recordId);
      return { ...current, items, count: items.length };
    });
  }

  async function markFinancialUnknown(recordId) {
    await apiRequest(`/api/records/${recordId}/field`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field: 'cost_data_source', value: 'UNKNOWN' }),
    });
    setFinancial(current => {
      if (!current) return current;
      const items = current.items.filter(item => item.record_id !== recordId);
      return { ...current, items, count: items.length };
    });
  }

  const corpusActions = completeness ? completeness.critical_gaps_count + completeness.financial_gaps_count : 0;
  const financialActions = financial ? financial.count : 0;
  const totalActions = corpusActions + queueItems.length + financialActions;
  const completenessScore = completeness?.completeness_score ?? 0;

  return (
    <AppShell active="queue" queueBadge={totalActions}>
      <section className="dashboard-main workspace-page">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Evidence Intelligence Workspace</p>
            <h1>Corpus Health, Review &amp; Financial Confirmation</h1>
          </div>
          <div className="tenant-pill queue-pill">
            <AlertTriangle size={16} />
            <span>{totalActions} actions pending</span>
          </div>
        </header>

        <section className="workspace-section" aria-label="All intelligence alerts">
          <div className="workspace-section-header">
            <h2><AlertTriangle size={20} /><span>Intelligence Alerts</span></h2>
            <span className="workspace-score-pill">{alerts.length} unread</span>
          </div>

          {alertsLoading ? (
            <p className="workspace-loading">Loading alerts...</p>
          ) : alerts.length === 0 ? (
            <article className="empty-panel compact">
              <CheckCircle2 size={24} />
              <p>No active alerts. Your evidence base is current.</p>
            </article>
          ) : (
            <div className="alert-grid">
              {alerts.map(alert => {
                const tier = alertTier(alert);
                return (
                  <article className={`alert-card tier-${tier.toLowerCase()}`} key={alert.id}>
                    <div className="alert-icon" aria-hidden="true">{alertIcons[alert.alert_type] || '📢'}</div>
                    <div>
                      <span className={`alert-tier-badge tier-${tier.toLowerCase()}`}>{ALERT_TIER_LABELS[tier]}</span>
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
                );
              })}
            </div>
          )}
        </section>

        <section className="workspace-section" aria-label="Corpus health">
          <div className="workspace-section-header">
            <h2><Database size={20} /><span>Corpus Health</span></h2>
            <span className={`workspace-score-pill ${completenessScore >= 80 ? 'complete' : 'urgent'}`}>
              {completenessLoading ? 'Calculating...' : `${completenessScore}% complete`}
            </span>
          </div>

          <div className="workspace-subsection">
            <h3 className="workspace-subsection-title urgent">Missing critical fields</h3>
            <div className="workspace-gap-grid">
              {completenessLoading ? (
                <p className="workspace-loading">Checking corpus completeness...</p>
              ) : !completeness || completeness.critical_gaps.length === 0 ? (
                <article className="empty-panel compact">
                  <CheckCircle2 size={24} />
                  <h3>No critical field gaps</h3>
                  <p>Every active record has its critical fields populated.</p>
                </article>
              ) : completeness.critical_gaps.map(gap => (
                <WorkspaceGapCard key={gap.record_id} gap={gap} onSaveField={saveCorpusField} />
              ))}
            </div>
          </div>

          <div className="workspace-subsection">
            <h3 className="workspace-subsection-title urgent">Missing financial fields</h3>
            <div className="workspace-gap-grid">
              {completenessLoading ? (
                <p className="workspace-loading">Checking financial completeness...</p>
              ) : !completeness || completeness.financial_gaps.length === 0 ? (
                <article className="empty-panel compact">
                  <CheckCircle2 size={24} />
                  <h3>No financial field gaps</h3>
                  <p>Every active record has its financial fields populated.</p>
                </article>
              ) : completeness.financial_gaps.map(gap => (
                <WorkspaceGapCard key={gap.record_id} gap={gap} onSaveField={saveCorpusField} />
              ))}
            </div>
          </div>
        </section>

        <section className="workspace-section" aria-label="System flagged">
          <div className="workspace-section-header">
            <h2><ShieldCheck size={20} /><span>System Flagged</span></h2>
            <span className={`workspace-score-pill ${queueItems.length === 0 ? 'complete' : 'urgent'}`}>
              {queueItems.length} pending
            </span>
          </div>

          <section className="review-list" aria-label="Expert review queue">
            {queueLoading ? (
              <p className="workspace-loading">Loading classifier review queue...</p>
            ) : queueItems.length === 0 ? (
              <article className="empty-panel compact">
                <CheckCircle2 size={24} />
                <h3>Queue clear</h3>
                <p>All low-confidence fields have been confirmed or overridden.</p>
              </article>
            ) : queueItems.map((item) => (
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
                  <button className="secondary-action" type="button" onClick={() => resolveQueueItem(item.id, item.recommendation)}>
                    <Check size={17} />
                    <span>Confirm</span>
                  </button>
                  <button
                    className="secondary-action"
                    type="button"
                    disabled={!overrideValues[item.id]}
                    onClick={() => resolveQueueItem(item.id, overrideValues[item.id], true)}
                  >
                    <Edit3 size={17} />
                    <span>Override</span>
                  </button>
                  <button className="secondary-action" type="button" onClick={() => skipQueueItem(item.id)}>
                    <SkipForward size={17} />
                    <span>Skip</span>
                  </button>
                </div>
              </article>
            ))}
          </section>
        </section>

        <section className="workspace-section" aria-label="Financial confirmation">
          <div className="workspace-section-header">
            <h2><Banknote size={20} /><span>Financial Records</span></h2>
            <span className={`workspace-score-pill ${financialActions === 0 ? 'complete' : 'urgent'}`}>
              {financialActions} unconfirmed
            </span>
          </div>

          <div className="workspace-gap-grid">
            {financialLoading ? (
              <p className="workspace-loading">Loading financial records...</p>
            ) : !financial || financial.items.length === 0 ? (
              <article className="empty-panel compact">
                <CheckCircle2 size={24} />
                <h3>All financial records confirmed</h3>
                <p>No extracted cost figures are waiting on confirmation.</p>
              </article>
            ) : financial.items.map(item => (
              <WorkspaceFinancialCard
                key={item.record_id}
                item={item}
                onConfirm={confirmFinancial}
                onMarkUnknown={markFinancialUnknown}
              />
            ))}
          </div>
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

class BriefErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('Brief render error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="brief-error">
          <strong>Display error</strong>
          <p>
            The brief was generated but could not be displayed. This is a rendering issue, not a data loss.
            Try again or contact your administrator.
          </p>
          <button
            className="btn-ghost"
            type="button"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function KnowledgePage() {
  const { records, source } = useLiveRecords();
  const querySynthesisId = new URLSearchParams(window.location.search).get('synthesis_id') || '';
  const eligibleRecords = records.filter(record => ['Tier 1', 'Tier 2'].includes(record.eqs_tier));
  const [selectedRecordId, setSelectedRecordId] = useState(eligibleRecords[0]?.adei_record_id || '');
  const [audience, setAudience] = useState(knowledgeAudiences[0].id);
  const [brief, setBrief] = useState('');
  const [briefProduct, setBriefProduct] = useState(null);
  const [briefError, setBriefError] = useState('');
  const [synthesisId, setSynthesisId] = useState(querySynthesisId);
  const [synthesis, setSynthesis] = useState(null);
  const [synthesisLoading, setSynthesisLoading] = useState(Boolean(querySynthesisId));
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    if (synthesisId) return;
    if (!eligibleRecords.length) return;
    if (!eligibleRecords.some(record => record.adei_record_id === selectedRecordId)) {
      setSelectedRecordId(eligibleRecords[0].adei_record_id);
    }
  }, [eligibleRecords, selectedRecordId, synthesisId]);

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

  const selectedRecord = eligibleRecords.find(record => record.adei_record_id === selectedRecordId) || eligibleRecords[0];
  const selectedAudience = knowledgeAudiences.find(item => item.id === audience) || knowledgeAudiences[0];
  const synthesisRecords = synthesis?.record_ids
    ? records.filter(record => synthesis.record_ids.includes(record.id) || synthesis.record_ids.includes(record.adei_record_id))
    : [];
  const displayProgrammeName = synthesisId
    ? (briefProduct?.programme_name || synthesis?.title || 'Strategic synthesis')
    : selectedRecord?.programme_name;
  const safeBrief = briefContent(brief);

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
    setBriefError('');
    setBrief('');
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
      if (!product) return;
      if (product.error) {
        setBriefError(product.error || product.message || 'Brief generation failed. Please try again.');
        return;
      }
      const generatedBrief = briefContent(product);
      if (!generatedBrief) {
        setBriefError('The evidence engine did not return a brief. Please try again.');
        return;
      }
      if (!selectedRecord && !synthesisId) {
        setBriefError('Record selection was lost. Please select a record and try again.');
        return;
      }
      setBrief(generatedBrief);
      setBriefProduct(product);
      return;
    } catch (err) {
      console.error('Brief generation error:', err);
      setBriefError(err?.payload?.error
        || err?.payload?.message
        || err?.message
        || 'Unable to generate brief. Check your connection and try again.');
    } finally {
      setIsGenerating(false);
    }
  }

  function reportSections() {
    if (synthesisId) {
      return [
        ['EXECUTIVE SUMMARY', safeBrief || 'Synthesis brief pending generation.'],
        ['KEY FINDING', (synthesis?.findings || []).map(item => item.finding).join(' ')],
        ['INVESTMENT AND REACH', (synthesis?.leverage_points || []).map(item => item.rationale).join(' ')],
        ['DECISION IMPLICATION', (synthesis?.leverage_points || []).map(item => item.action).join(' ')],
        ['EVIDENCE CONFIDENCE', `Based on synthesis of ${synthesis?.record_count || briefProduct?.source_record_count || 0} records.`],
        ['RECOMMENDED ACTION', (synthesis?.leverage_points || [])[0]?.action || 'Review the synthesis and select the relevant audience action.'],
        ['SUPPORTING RECORDS', (synthesis?.record_ids || []).join(' · ')],
      ];
    }
    return [
      ['EXECUTIVE SUMMARY', safeBrief || `${selectedRecord.programme_name} is a ${selectedRecord.eqs_tier} record with EQS ${selectedRecord.eqs_composite}.`],
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
                    className={record.adei_record_id === selectedRecordId ? 'selected' : ''}
                    type="button"
                    key={record.adei_record_id}
                    onClick={() => {
                      setSelectedRecordId(record.adei_record_id);
                      setBrief('');
                      setBriefProduct(null);
                      setBriefError('');
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
                    setBriefError('');
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
              <button className="secondary-action" type="button" disabled={!safeBrief && !selectedRecord} onClick={copyBrief}>
                <ClipboardCopy size={17} />
                <span>Copy</span>
              </button>
              <button className="secondary-action" type="button" disabled={!safeBrief} onClick={() => window.print()}>
                <Download size={17} />
                <span>Download PDF</span>
              </button>
              <button className="secondary-action" type="button" disabled={!safeBrief} onClick={() => downloadWord(`${synthesisId || recordId(selectedRecord)}-${audience}.doc`, reportText().replace(/\n/g, '<br>'))}>
                <Download size={17} />
                <span>Download Word</span>
              </button>
              <button className="btn-ghost" type="button" disabled={!briefProduct?.provenance_id} onClick={() => navigate(`/provenance/${briefProduct.provenance_id}`)}>
                View Provenance
              </button>
            </div>
          </div>

          <BriefErrorBoundary>
            {isGenerating ? (
              <div className="brief-loading">
                <span className="pulse-dot" />
                <strong>Generating {selectedAudience.label} brief for {displayProgrammeName}...</strong>
              </div>
            ) : briefError ? (
              <div className="brief-error">
                <strong>Generation failed</strong>
                <p>{briefError}</p>
                <button
                  className="btn-ghost"
                  type="button"
                  onClick={() => {
                    setBriefError('');
                    generateBrief();
                  }}
                >
                  Try again
                </button>
              </div>
            ) : safeBrief ? (
              <article className="report-card brief-output">
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
                      <p>Record: {recordId(selectedRecord)} | Classified: {formatDisplayDate(selectedRecord?.classified_at || selectedRecord?.classification_date)}</p>
                      <p>
                        {selectedRecord?.eqs_tier
                          ? `Evidence tier: ${selectedRecord.eqs_tier} | EQS: ${selectedRecord.eqs_composite}/5.0`
                          : briefProduct?.source_record_count
                            ? `Based on synthesis of ${briefProduct.source_record_count} records`
                            : ''}
                      </p>
                    </>
                  )}
                  {briefProduct?.word_count && <p>Word count: {briefProduct.word_count}</p>}
                </header>
                <section>
                  <div
                    className="ask-answer-body"
                    dangerouslySetInnerHTML={{ __html: safeRenderMarkdown(safeBrief) }}
                  />
                </section>
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
          </BriefErrorBoundary>
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

function adminAskApi(path, options = {}) {
  const authHeaders = browserIdToken ? { Authorization: `Bearer ${browserIdToken}` } : {};
  return apiRequest(`/api/admin-ask${path}`, {
    ...options,
    tenant: 'admin',
    role: 'SUPER_ADMIN',
    user: 'emmanuel@auxeira.com',
    headers: {
      ...authHeaders,
      ...(options.headers || {}),
    },
  });
}

async function adminAskRequest(path, options = {}) {
  const token = browserIdToken || sessionStorage.getItem(ID_TOKEN_STORAGE_KEY) || browserAccessToken || sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
  const response = await fetch(`/api/admin-ask${path}`, {
    ...options,
    headers: {
      'x-evidenceos-tenant': 'admin',
      'x-evidenceos-role': 'SUPER_ADMIN',
      'x-evidenceos-user': 'emmanuel@auxeira.com',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    throw new Error(
      'API routing error: received HTML instead of JSON. Check CloudFront configuration.'
    );
  }

  if (response.status === 401) {
    browserIdToken = '';
    browserAccessToken = '';
    sessionStorage.removeItem(ID_TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
    window.location.href = '/admin/login?reason=expired';
    return undefined;
  }

  const rawText = await response.text();
  let payload = null;
  if (rawText) {
    const looksLikeHtml = /^\s*<!doctype html/i.test(rawText) || /^\s*<html/i.test(rawText);
    if (looksLikeHtml) {
      throw new Error('Ask Auxeira received the frontend page instead of the API response. API routing is not reaching /api/admin-ask/ask.');
    }
    try {
      payload = JSON.parse(rawText);
    } catch (err) {
      if (!response.ok) {
        throw new Error(rawText.slice(0, 300) || response.statusText || 'Ask Auxeira request failed');
      }
      throw new Error('Ask Auxeira returned a non-JSON response. Please try again.');
    }
  }

  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || response.statusText || 'Ask Auxeira request failed');
  }

  return payload || {};
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
          <a className={active === 'ask' ? 'active' : ''} href="/admin/ask">
            <Search size={18} />
            <span>Ask Auxeira</span>
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

function AdminAskPage() {
  const examplePrompts = [
    'Why did ADEI-ZF-004 score 2.73 on the Research pathway?',
    'Compare Zenex and Optima corpus coverage',
    'Explain the Three-Capital Cascade calculation',
    'Why was a CURRENCY_ALERT generated for Funda Wande?',
    'What is the EROI index formula?',
  ];
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function askAuxeira(value = question) {
    const trimmed = value.trim();
    if (trimmed.length < 3) return;
    setQuestion(trimmed);
    setLoading(true);
    setError('');
    setAnswer(null);
    try {
      const data = await adminAskRequest('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      });
      if (!data) return;
      setAnswer(data);
    } catch (err) {
      setError(err.message || 'Ask Auxeira could not respond. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    askAuxeira();
  }

  return (
    <AdminShell active="ask">
      <section className="dashboard-main admin-ask-page">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Founder intelligence</p>
            <h1>Ask Auxeira</h1>
            <p className="page-subheader">Platform intelligence for the Auxeira founder console</p>
            <p className="admin-ask-subline">
              Covers EQS methodology, cross-tenant analytics, scoring explanations, and system diagnostics
            </p>
          </div>
        </header>

        {!answer && !loading && (
          <div className="prompt-chip-grid admin-ask-prompts">
            {examplePrompts.map(prompt => (
              <button key={prompt} type="button" onClick={() => askAuxeira(prompt)}>
                {prompt}
              </button>
            ))}
          </div>
        )}

        <form className="ask-search-panel admin-ask-search" onSubmit={handleSubmit}>
          <label className="ask-input">
            <Search size={20} />
            <input
              value={question}
              onChange={event => setQuestion(event.target.value)}
              placeholder="Ask anything about the platform, methodology, or tenant performance..."
            />
          </label>
          <button className="primary-action" type="submit" disabled={loading || question.trim().length < 3}>
            <span>{loading ? 'Asking...' : 'Ask'}</span>
          </button>
        </form>

        {loading && (
          <div className="pulse-loading">
            <span className="pulse-dot" />
            <span className="pulse-dot" />
            <span className="pulse-dot" />
            <span>Analysing platform context...</span>
          </div>
        )}

        {error && (
          <div className="brief-error">
            <strong>Ask Auxeira failed</strong>
            <p>{error}</p>
            <button className="btn-ghost" type="button" onClick={() => askAuxeira()}>
              Try again
            </button>
          </div>
        )}

        {answer?.answer && (
          <article className="ask-answer-card admin-ask-answer">
            <div
              className="ask-answer-body"
              dangerouslySetInnerHTML={{ __html: safeRenderMarkdown(answer.answer) }}
            />
            <footer className="ask-result-meta">
              Covering {answer.tenants_covered || 0} tenants · {dateTimeStamp(answer.generated_at)}
            </footer>
          </article>
        )}
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
  const user = currentUser();
  const [usersList, setUsersList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [ratifying, setRatifying] = useState(false);
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

  async function handleRatifyV2() {
    setError('');
    setToast('');
    setRatifying(true);
    try {
      const result = await apiRequest('/api/settings/ratify-eqs', {
        method: 'POST',
      });
      setToast(result.message || 'EQS v2.0 ratified for new classifications.');
    } catch (err) {
      setError(err.message);
    } finally {
      setRatifying(false);
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

        {user.role === 'ORGANISATION_LEAD' && (
          <section className="methodology-version-card">
            <div>
              <p className="eyebrow">Methodology</p>
              <h3>Evidence Quality Score Methodology</h3>
              <p className="methodology-current">Current version: EQS v2.0</p>
              <p>
                EQS v2.0 introduces three evaluation pathways so process, formative,
                and impact evaluations are each judged against their intended purpose.
                Existing scores are preserved. Only new classifications will use v2.0.
                This action is recorded with your name and timestamp.
              </p>
              <p className="muted">
                Fatima Adam is the methodology ratifier. Process evaluations are scored
                for implementation quality, and research studies are scored for synthesis
                quality and policy relevance.
              </p>
            </div>
            <button
              className="secondary-action"
              type="button"
              onClick={handleRatifyV2}
              disabled={ratifying}
            >
              {ratifying ? 'Ratifying...' : 'Ratify EQS v2.0 Methodology'}
            </button>
          </section>
        )}

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
  if (path === '/admin/ask') return <AdminAskPage />;
  if (path === '/admin/tenants') return <AdminTenantsPage />;
  if (path === '/admin/support') return <AdminSupportPage />;
  if (path === '/login') return <LoginPage />;
  if (path === '/change-password') return <ChangePasswordPage />;
  if (path === '/dashboard') return <DashboardPage />;
  if (path === '/records') return <RecordsPage />;
  if (path === '/synthesise') return <SynthesisePage />;
  if (path === '/tor-generator') return <TorGeneratorPage />;
  if (path === '/ask') return <AskZenexPage />;
  if (path === '/classify') return <ClassifyPage />;
  if (path === '/queue') return <WorkspacePage />;
  if (path === '/products') return <KnowledgePage />;
  if (path === '/knowledge') return <KnowledgePage />;
  if (path.startsWith('/provenance/')) return <ProvenancePage />;
  if (path === '/settings') return <SettingsPage />;
  if (path === '/exec') return <ExecPage />;
  return <LandingPage />;
}

createRoot(document.getElementById('root')).render(<App />);

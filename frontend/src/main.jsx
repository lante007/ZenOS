import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Clock3,
  Database,
  Download,
  Filter,
  FileCheck2,
  FileText,
  Gauge,
  Layers3,
  LockKeyhole,
  Mail,
  Search,
  ShieldCheck,
  Sparkles,
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

function queueCount() {
  return workQueue.filter(item => item.state !== 'Ready').length;
}

function DashboardNav({ active }) {
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
            <strong className="nav-badge">{queueCount()}</strong>
          </a>
          <a className={active === 'knowledge' ? 'active' : ''} href="/knowledge">
            <Sparkles size={18} />
            <span>Products</span>
          </a>
          <a href="/dashboard">
            <Users size={18} />
            <span>Users</span>
          </a>
        </nav>
      </aside>
    </>
  );
}

function AppShell({ active, children }) {
  return (
    <main className="dashboard-shell">
      <DashboardNav active={active} />
      {children}
    </main>
  );
}

function DashboardPage() {
  const evidenceHealthScore = 82;

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
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({ tier: 'all', type: 'all', phase: 'all', province: 'all' });
  const [selectedRecord, setSelectedRecord] = useState(null);

  const filteredRecords = useMemo(() => {
    return mockRecords.filter((record) => {
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
  }, [query, filters]);

  const unique = (field) => [...new Set(mockRecords.map(record => record[field]).filter(Boolean))];

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
            <span>55-field ADEI taxonomy v2.1</span>
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

  function startPipeline() {
    setActiveStep(0);
    pipelineSteps.forEach((_, index) => {
      window.setTimeout(() => setActiveStep(index), index * 360);
    });
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
              <span>{isComplete ? 'Expert queue and EQS outputs are prepared for review.' : 'Progress updates will stream here from the live API.'}</span>
            </div>
          </article>
        </section>
      </section>
    </AppShell>
  );
}

function App() {
  if (window.location.pathname === '/login') return <LoginPage />;
  if (window.location.pathname === '/dashboard') return <DashboardPage />;
  if (window.location.pathname === '/records') return <RecordsPage />;
  if (window.location.pathname === '/classify') return <ClassifyPage />;
  return <LandingPage />;
}

createRoot(document.getElementById('root')).render(<App />);

# EVIDENCEOS — MASTER SYSTEM PROMPT
## Auxeira · Evidence Intelligence Infrastructure for Philanthropy
## Version 1.0 · July 2026 · CONFIDENTIAL BUILD SPECIFICATION

---

## PLATFORM IDENTITY

You are building **EvidenceOS**, a commercial multi-tenant SaaS platform developed by
Auxeira that converts institutional evaluation archives into structured, scored,
audience-calibrated evidence intelligence. The platform serves African philanthropy,
government, and development sector organisations. Each client organisation operates
on an isolated tenant at their own subdomain (e.g. zenex.auxeira.com,
optima.auxeira.com). The platform brand is Auxeira. The product brand is EvidenceOS.

The platform is built on three proprietary frameworks, all fully specified in the
Auxeira developer repository (github.com/lante007/ZenOS):

1. **ADEI Classification Taxonomy v2.1** — 55-field evidence intelligence taxonomy
   across three layers (L1: 9 administrative fields, L2: 25 evidence fields,
   L3: 21 intelligence fields). Full field list in ADEI_Spec_v2_1_July2026.docx.

2. **Evidence Quality Score (EQS) Scoring Logic v0.2** — five-dimension weighted
   formula: Rigour (35%), Data Quality (20%), Transparency (15%),
   Replicability (15%), Context Relevance (15%). Tiers: Tier 1 ≥3.5 (board-
   citable), Tier 2 2.5–3.49 (publishable), Tier 3 1.5–2.49 (internal),
   Excluded <1.5. Research Studies do not receive EQS scores.

3. **Three-Capital Valuation Framework** — Financial Capital → Evidence Capital →
   Decision Capital → EROI → Institutional Capital. Full specification in
   Auxeira_ThreeCapital_ValuationFramework_v1_1.docx.

Six protocol amendments are active and non-negotiable in all classification logic:
- PA1: Null findings classified at same confidence tier as positive findings
- PA2: Process evaluations never receive causal attribution
- PA3: SROI cost inputs from audited financials or approved Proxy Library only
- PA4: Confidence tiers disaggregated by unit of analysis
- PA5: Non-significant tested variables explicitly reported
- PA6: Decision relevance by asymmetry (challenging assumptions outranks confirming)

The Zenex Foundation pilot corpus comprises 74 classified documents across 23
independent programme cases. Reference: EvidenceOS_Autonomous_Ingestion_Engine_
Gitpod_Spec_v2_0.docx and the programme cluster map in programme-detector.js.

---

## TECHNOLOGY STACK

**Frontend:** React 18 SPA. Single codebase, per-tenant build via environment
variables (REACT_APP_TENANT, REACT_APP_THEME). Deployed to S3 static bucket per
tenant. CloudFront distribution per subdomain.

**Backend:** Node.js 20 / Express 4. Multi-tenant middleware routes every request
to the correct tenant context via subdomain parsing. Deployed on AWS ECS Fargate
(af-south-1). One cluster, one service, multiple tasks.

**AI Classification Engine:**
- PRIMARY: Anthropic Claude claude-sonnet-4-6 via Anthropic API (not Bedrock).
  Used for full 55-field ADEI classification, EQS scoring, and knowledge product
  generation. Temperature 0 for classification, 0.3 for knowledge products.
  Max tokens: 2000 for classification, 500 for knowledge products.
- TIER 2 RESOLUTION: AWS Bedrock Claude Haiku (af-south-1). Used for low-
  confidence field resolution (confidence < 0.60) before escalating to expert queue.
- TIER 3: Expert queue (Fatima Adam for Zenex, equivalent per tenant). Maximum
  10 items per batch. Override logged with timestamp and reviewer ID.

**Database:** AWS RDS PostgreSQL 15 (db.t3.medium, af-south-1). One cluster.
Separate schema per tenant enforced via connection pool search_path setting.
Schema names match tenant slugs (zenex, optima, float).

**Document Storage:** AWS S3. Separate bucket per tenant.
Convention: auxeira-evidenceos-{tenant-slug}.
Structure per bucket:
  raw/documents/     ← uploaded source files (private, encrypted)
  processed/text/    ← extracted text per document
  processed/records/ ← full ADEI JSON intelligence records
  queue/             ← Fatima queue JSON exports
  exports/knowledge/ ← generated audience briefs
  exports/reports/   ← annual reports, CSV exports

**Queue:** AWS SQS. One queue per tenant for async classification jobs.
Queue name: evidenceos-classify-{tenant-slug}.

**Authentication:** AWS Cognito. One User Pool per tenant.
JWT tokens carry: sub (user ID), tenant_id, role, email.

**Secrets:** AWS Secrets Manager. No credentials in code or .env files in production.
Secret names: evidenceos/{tenant-slug}/anthropic-key,
evidenceos/{tenant-slug}/db-url, evidenceos/master/jwt-secret.

**Infrastructure as Code:** AWS CDK (TypeScript). Stack per tenant.

**CI/CD:** GitHub Actions. On push to main: run tests, build React per active
tenant, deploy to S3, invalidate CloudFront cache.

**Monitoring:** AWS CloudWatch. Alerts on: classification failure rate >5%,
queue depth >20, API p95 latency >3s, Anthropic API errors.

**DNS:** Route 53. Wildcard certificate *.auxeira.com via ACM.
A records: zenex.auxeira.com, optima.auxeira.com, admin.auxeira.com.

---

## USER HIERARCHY AND PERMISSIONS

### Level 0 — SuperAdmin (Emmanuel Luthuli / Auxeira)
Access: admin.auxeira.com. Full platform visibility across all tenants.

Capabilities:
- Create, configure, suspend, and delete tenant organisations
- View all tenant dashboards, corpora, and billing status
- Set per-tenant feature flags (federated network, SROI module, public corpus)
- Manage Anthropic API key allocation per tenant
- View platform-wide classification volume, API costs, and error logs
- Access the federated intelligence layer across all participating tenants
- Set taxonomy version per tenant (lock or allow upgrade)
- Impersonate any tenant user for support purposes (logged)
- Manage the Auxeira Proxy Library (SROI proxy values)
- Configure the sector benchmarking dataset
- Publish the Evidence Quality Standard updates

SuperAdmin UI screens:
- Platform Dashboard (tenant count, MRR, classification volume, API costs)
- Tenant Manager (create/edit/suspend tenants, set subdomain, feature flags)
- Classification Monitor (real-time job queue across all tenants)
- Corpus Health (EQS distribution, tier breakdown per tenant)
- Federated Network Console (which tenants contribute what to shared corpus)
- Billing & Usage (API tokens consumed, storage, active users per tenant)
- System Logs (errors, overrides, impersonation audit trail)

---

### Level 1 — Tenant Admin / CEO
Access: {tenant}.auxeira.com. Full access within their tenant only.

Typical users: Sibongile Khumalo (Zenex CEO), Sarah Cairns (Optima CEO).

Capabilities:
- All capabilities of all lower user levels within their tenant
- Invite and manage users within their organisation
- Configure tenant settings (logo, colours, fiscal year, SROI proxy overrides)
- Authorise documents for the federated corpus (approve what crosses the boundary)
- View full Three-Capital Valuation dashboard including EROI and Institutional Capital
- Approve knowledge products for external publication
- Access audit log of all classification overrides within their tenant
- Generate and download the Annual Evidence Intelligence Report
- Configure the Board Evidence Intelligence Dashboard

---

### Level 2 — Evidence Director
Access: {tenant}.auxeira.com. Full evidence intelligence capabilities, no user management.

Typical users: Fatima Adam (Zenex Director of Programmes).

Capabilities:
- Review and ratify all Tier 3 queue items (expert override authority)
- Co-design EQS scoring logic (flag disagreements for SuperAdmin review)
- Classify documents manually (override AI classification on any field)
- Commission new evaluations from within the system (TOR generation)
- Run cross-portfolio synthesis queries
- Access full 55-field intelligence record for every classified document
- Set per-document rights status (CLEAR, RESTRICTED, DO NOT CITE)
- View and export the evidence gap register
- Annotate audience persona profiles
- Access inter-rater reliability reports

---

### Level 3 — Communications Manager
Access: {tenant}.auxeira.com. Knowledge products and publications only.

Typical users: Ruth Rakosa (Zenex Communications Manager).

Capabilities:
- Generate audience-calibrated knowledge products from classified records
- View evidence summaries (not full 55-field detail)
- Download and share knowledge products for external publication
- View the Evidence Health Score and portfolio overview on the dashboard
- Access the searchable evidence library (read-only)
- Request a knowledge product from a record (triggers generation, not immediate access)
- View the publication calendar and editorial pipeline
- Cannot access raw documents, EQS dimension scores, or queue items

---

### Level 4 — Trustee / Board Member
Access: {tenant}.auxeira.com. Dashboard and reports only.

Typical users: Zenex Board (Thandi Orleyn, Sizwe Nxasana, Sindi Mabaso-Koyana).

Capabilities:
- View the Board Evidence Intelligence Dashboard (real-time)
- Access the Trustee Evidence Pack (quarterly PDF)
- View portfolio-level KPIs: Evidence Capital score, Tier 1 count, Decision Capital instances, EROI
- Download board-ready evidence summaries
- Cannot see individual document classifications or raw evidence records

---

### Level 5 — Guest / Viewer
Access: {tenant}.auxeira.com. Preview only, no writes.

Typical users: Demo visitors, prospective clients, interns.

Capabilities:
- View the dashboard with anonymised or sample data
- Cannot upload, classify, or generate knowledge products

---

## AUTHENTICATION AND ONBOARDING FLOW

### Sign-Up (Tenant Admin creates their own account)
1. Admin navigates to {tenant}.auxeira.com/signup
2. System verifies the subdomain maps to an active tenant (provisioned by SuperAdmin)
3. User enters name, email, password (min 12 chars, 1 uppercase, 1 number, 1 special)
4. Cognito creates the user in the tenant-specific user pool
5. Verification email sent (Cognito hosted UI or custom SES template)
6. On verification, user is assigned the Tenant Admin role automatically
   if they are the first user in the tenant pool, otherwise Level 3 default
7. Redirect to onboarding wizard (Step 1: upload first document)

### Sign-In Flow
1. User navigates to {tenant}.auxeira.com → redirect to /login
2. Email + password form (or Google SSO if configured for enterprise tenants)
3. Cognito validates credentials, returns JWT (access token + ID token + refresh token)
4. Frontend stores tokens in memory (not localStorage)
5. API requests carry Authorization: Bearer {access_token}
6. Backend middleware validates token, extracts tenant_id and role, injects into req.user
7. Redirect to role-appropriate landing screen:
   - SuperAdmin → admin.auxeira.com/dashboard
   - Tenant Admin → /dashboard (full Three-Capital view)
   - Evidence Director → /records (evidence library with queue badge)
   - Communications → /knowledge (knowledge products)
   - Trustee → /board (board dashboard)

### Password Reset
Standard Cognito flow. Custom SES email template with Auxeira branding.

### Session Management
Access tokens expire after 1 hour. Refresh tokens expire after 30 days.
Silent refresh via Cognito SDK. Force logout on tenant suspension.

---

## DATABASE SCHEMA (PostgreSQL, per-tenant schema)

### Core Tables (replicated in each tenant schema)

**documents**
id (UUID PK), tenant_id, s3_key, filename, mime_type, file_size_bytes,
file_hash (SHA-256, for deduplication), upload_source (DRIVE | S3 | UPLOAD),
rights_status (CLEAR | RESTRICTED | CONFIDENTIAL | DO_NOT_CITE),
extraction_quality (GOOD | ADEQUATE | LOW | FAILED),
ingestion_status (PENDING | PROCESSING | COMPLETE | FAILED | SOFT_DELETED),
ingested_by (user_id), ingested_at (timestamptz), created_at (timestamptz)

**intelligence_records**
id (VARCHAR, format: ADEI-{TENANT}-{SEQUENCE}), tenant_id, document_id (FK),
-- L1 Administrative (9 fields)
document_type, evaluation_subtype, programme_name, phase, year,
fiscal_year, funder_names (TEXT[]), co_funder_documented, rights_status,
-- L2 Evidence (25 fields)
provinces (TEXT[]), sample_size_learners, sample_size_schools,
has_control_group, methodology_description, key_finding_1, key_finding_2,
key_finding_3, null_findings_reported, cost_data_present,
theory_of_change_explicit, external_evaluator, fidelity_reported,
dosage_documented, publication_status, policy_relevance_score,
strategic_value_score, nls_alignment, funrs_alignment,
dbe_adoption_status, audience_relevance (TEXT[]),
evidence_gap_1, evidence_gap_2, commissioning_standards_met,
-- L3 Intelligence (21 fields)
eqs_composite, eqs_tier (TIER_1|TIER_2|TIER_3|EXCLUDED|N_A),
dim_methodological_rigour, dim_data_quality, dim_transparency,
dim_replicability, dim_context_relevance,
half_life_rating (CURRENT|AGING|HISTORICAL),
evidence_capital_score, policy_relevance_weight,
decision_capital_tier, decision_capital_description, decision_capital_reach,
assumption_challenged, finding_type, evidence_contradiction_flag,
per_finding_confidence_flag, decision_context_note,
commissioning_guidance_flag, sroi_eligible, board_citable,
-- Metadata
classified_by (CLAUDE_SONNET|BEDROCK_HAIKU|EXPERT_OVERRIDE),
classification_confidence JSONB, taxonomy_version,
scoring_logic_version, fatima_reviewed_at, fatima_reviewed_by,
created_at, updated_at, record_status (ACTIVE|SUPERSEDED|PENDING_REVIEW)

**queue_items**
id (UUID PK), tenant_id, record_id (FK), document_id (FK),
field_name, claude_value, claude_confidence, bedrock_value, bedrock_confidence,
system_recommendation, reviewer_id (FK users), reviewer_override,
resolved_value, is_override (BOOLEAN), resolved_at (timestamptz),
resolution_tier (3), created_at

**knowledge_products**
id (UUID PK), tenant_id, record_id (FK), audience
(TRUSTEE|CEO|DBE_NATIONAL|PROVINCIAL_HOD|CO_FUNDER|SECTOR_PEER),
content (TEXT), generated_by (user_id), model_used,
approved_by (user_id), approved_at, published_at,
word_count, created_at

**decision_capital_instances**
id (UUID PK), tenant_id, record_id (FK),
tier (TIER_1|TIER_2|TIER_3),
description, decision_maker, organisation,
financial_value_rand, learners_affected, reach_description,
documented_evidence (TEXT), confirmed_by (user_id), confirmed_at,
created_at

**users**
id (UUID PK), tenant_id, cognito_sub (VARCHAR UNIQUE),
email, full_name, role (SUPER_ADMIN|TENANT_ADMIN|EVIDENCE_DIRECTOR|
COMMUNICATIONS|TRUSTEE|GUEST),
last_login_at, created_at, is_active

**tenants** (master schema only, not replicated)
id (UUID PK), slug (VARCHAR UNIQUE), name, subdomain,
logo_s3_key, primary_colour, secondary_colour,
s3_bucket, cognito_pool_id, cognito_client_id,
db_schema, sqs_queue_url,
tier (STARTER|PROFESSIONAL|ENTERPRISE|FEDERATED),
feature_flags JSONB, max_documents, max_users,
is_active, created_at, trial_ends_at

**ingestion_jobs**
id (UUID PK), tenant_id, document_id (FK), batch_id,
status (QUEUED|PROCESSING|COMPLETE|FAILED),
pipeline_step (1..8), step_detail,
claude_input_tokens, claude_output_tokens, claude_latency_ms,
error_message, started_at, completed_at

---

## APPLICATION SCREENS AND MODULES

### All tenants (role-gated as specified above)

**1. Authentication**
/login — Email/password sign-in. Social SSO if configured.
/signup — First-user registration (Tenant Admin auto-role).
/forgot-password — Cognito reset flow.
/mfa — TOTP if enabled at tenant level.

**2. Dashboard** (role-gated: full view for Admin/Evidence Director, KPI-only for Trustee)
Evidence Health Score (portfolio EQS aggregate with grade A–F)
Four-Capital cascade: Financial Capital → Evidence Capital → Decision Capital → EROI
Tier distribution chart (Tier 1 / Tier 2 / Tier 3 / Research Studies)
Decision Capital register (confirmed instances with reach data)
Evidence Currency alerts (documents approaching historical classification)
Portfolio coverage map (which programmes have endline data, which have gaps)
Queue badge (items pending expert review)
Recent activity feed

**3. Evidence Library** (/records)
Searchable, filterable table of all classified intelligence records
Filters: tier, document type, phase, province, year, programme, audience
Sort: EQS descending, year, programme name
Full 55-field detail modal per record
Parent-child cluster view (group related documents)
Export: CSV, JSON, PDF summary

**4. Classify** (/classify)
Drag-drop upload (PDF, DOCX, PPTX) → S3 → SQS → ingestion engine
Google Drive file ID input (for Drive-based clients)
S3 folder sync (batch classify all new documents in bucket prefix)
Real-time pipeline progress (8-step visual with current step label)
Post-classification preview (show EQS score and tier immediately)
Settings: institution, taxonomy version, SROI gate on/off

**5. Expert Review Queue** (/queue) — Evidence Director only
List of Tier 3 resolution items (low-confidence fields)
Per-item: field name, Claude recommendation, confidence, alternatives
Actions: Confirm recommendation, Select alternative, Override with custom value
Bulk confirm all recommendations (with confirmation modal)
Inter-rater reliability report (% agreement between AI and expert over time)
Queue drain target: <10 items per batch session

**6. Knowledge Products** (/knowledge)
Select an intelligence record from dropdown (Tier 1 and Tier 2 only)
Select audience (6 options)
Generate brief (calls Claude claude-sonnet-4-6 via API, ~3 second response)
Display generated brief with copy and download actions
Approval workflow: Communications Manager requests → Evidence Director approves → Tenant Admin publishes
Publication log (all generated and published briefs with timestamp and audience)

**7. Evidence Translation** (/translation) — from Optima demo
Eight-touchpoint communications journey per major evaluation:
Research publication → Executive brief → Policy brief → Stories of Impact →
LinkedIn article → Infographic brief → Webinar outline → Conference abstract
Auto-generates all eight from a single classified record on request
Communications calendar integration (schedule publication sequence)

**8. Strategic Synthesis** (/synthesis) — Evidence Director and above
Cross-portfolio query interface: "What does all Foundation Phase coaching evidence show?"
System queries classified corpus, returns synthesised findings with confidence ratings
Citation chain: every finding linked to its source intelligence record
Exports synthesis as a structured brief (PDF or DOCX)
Powered by: Anthropic claude-sonnet-4-6 with the full classified corpus as context
Token management: corpus summary injected, not raw text (prevents context overflow)

**9. Portfolio Optimizer** (/optimizer) — Tenant Admin and above (from Optima demo)
Investment slider by programme phase
SROI calculation from Proxy Library values and audited cost data
Counterfactual modelling: what would outcomes have been without this investment?
Evidence gap visualisation: where is the portfolio under-evaluated?
Commissioning priority matrix: which programmes need endline data most urgently?
Next commission recommendation (generated from gap register)

**10. Provenance Record** (/provenance) — Evidence Director and above (from Optima demo)
Full audit chain for any classified claim:
Source document → Extraction → Classification → EQS scoring → Expert override (if any) →
Knowledge product → Publication
Every step timestamped and signed with the model or user that performed it
Exportable as a provenance certificate (for funder accountability)

**11. Board Dashboard** (/board) — Trustee view
Four KPI tiles: Evidence Capital score, Tier 1 count, Decision Capital instances, EROI
Evidence Health gauge (A–F)
Portfolio phase coverage (Foundation Phase / Senior Phase / Grade R / System-Wide)
Three most recent Decision Capital instances (plain language)
Trustee Evidence Pack download (quarterly PDF, auto-generated from corpus)
No raw data, no document-level detail

**12. Commissioning Intelligence** (/commission) — Evidence Director only
TOR generation from gap register (selects a programme, generates a draft TOR
pre-populated with minimum standards and evidence gaps that must be addressed)
Pre-proposal assessment form (submit an implementing organisation proposal for
automated quality scoring against the nine commissioning standards)
Evidence gap register (full list, sortable by priority and currency)

**13. Settings** (/settings) — Tenant Admin only
Organisation profile (name, logo, colours, fiscal year)
User management (invite, assign role, deactivate)
SROI proxy overrides (client-specific proxy values replacing Auxeira defaults)
Federated corpus settings (which document categories are approved for federation)
Notification preferences (email alerts for queue items, currency alerts, reports)
API credentials (read-only API key for external integrations)
Audit log (all user actions, overrides, and exports with timestamp)

---

## SUPERADMIN CONSOLE (admin.auxeira.com) — Emmanuel only

**Platform Dashboard**
Active tenants, MRR, total documents classified today, API token spend (today / month),
classification success rate, queue items pending across all tenants

**Tenant Manager**
Create new tenant: slug, name, subdomain, tier, feature flags, max_documents
Edit tenant: change tier, update feature flags, set trial expiry
Suspend tenant: locks login, preserves data
Delete tenant: 30-day soft delete before permanent removal
View any tenant's corpus and dashboard in read-only mode (impersonation logged)

**Classification Monitor**
Real-time SQS job feed across all tenants
Failed jobs with error detail
Anthropic API usage by tenant (tokens, cost, error rate)
Bedrock usage by tenant

**Federated Network Console**
Which tenants are in the federated corpus
Per-tenant: documents contributed vs documents consumed from network
Cross-tenant synthesis queries (SuperAdmin only)
Governance log: which documents were approved for federation by which Tenant Admin

**Billing and Usage**
Per-tenant: documents classified (month / total), API tokens consumed (month / total),
storage used (GB), active users, feature tier
Export usage report (CSV, for invoicing)

**System Health**
RDS connection pool status per tenant
S3 bucket sizes and costs per tenant
CloudFront cache hit rate per tenant
ECS task health
SQS queue depths

---

## ACTIVE AI BACKEND — CONFIGURATION REFERENCE

All AI calls route through a single AIService module that handles:
- Model selection based on task type (Sonnet for classification/synthesis,
  Haiku via Bedrock for Tier 2 resolution)
- Retry logic (3 attempts with exponential backoff on 429 and 529 errors)
- Token counting and cost logging per tenant
- Response validation (JSON schema check before any write)
- Fallback to Tier 3 queue if both models fail on a field

**Classification call:**
Model: claude-sonnet-4-6
Temperature: 0
Max tokens: 2000
System prompt: ADEI classification engine context (taxonomy rules, protocol amendments,
client institution context, current date)
User message: Document text + pre-detected programme and role

**Knowledge product call:**
Model: claude-sonnet-4-6
Temperature: 0.3
Max tokens: 600
System prompt: Audience profile + communication standards
User message: Intelligence record fields + audience selection

**Synthesis call:**
Model: claude-sonnet-4-6
Temperature: 0.2
Max tokens: 3000
System prompt: ADEI synthesis rules + confidence citation requirements
User message: Query + relevant record summaries (not full text, summarised per record)

**Tier 2 resolution call (Bedrock):**
Model: anthropic.claude-haiku-20240307 (af-south-1)
Temperature: 0
Max tokens: 200
Input: Field name + ambiguous value + document excerpt (500 chars)
Output: Resolved value + confidence (0.0–1.0)

---

## UI DESIGN REFERENCE

Primary design reference: AuxeiraOptimaDemo2.html (the Optima demo).
This sets the standard for component quality, typography, and interaction design.

**Auxeira Platform Palette (default for all tenants):**
--navy: #0A1628 (background)
--navy-mid: #0F2040 (sidebar, cards)
--teal: #00B4D8 (primary accent, CTAs)
--teal-light: #E8F7FB (highlight backgrounds)
--white: #F5F2EE (body text)
--gray: #8A9BB5 (secondary text)

**Tenant Theming (overrides per tenant):**
Zenex Foundation: --primary: #EF7218, --secondary: #311F47, logo from S3
Optima: TBD from Optima brand guide

**Typography:**
Display: Cormorant Garamond (serif, EvidenceOS brand headlines)
Body: DM Sans (clean, professional, readable at small sizes)

**Component standards (from Optima demo):**
Confidence badges: conf-t1 (green), conf-t2 (amber), conf-t3 (red)
Document items: doc-item with doc-icon, doc-title, doc-meta, doc-summary
Finding rows: teal left border, gap rows: red left border
Provenance chain: dot-connector vertical timeline
Portfolio sliders: custom range input with teal thumb and tick labels
Knowledge product output: kp card with org label, title, audience, sections, export bar

**Responsive:** minimum 1024px desktop. Mobile view for Trustee dashboard only.

---

## REPOSITORY STRUCTURE (github.com/lante007/ZenOS)

```
ZenOS/
├── adei-ingest.js              ← CLI batch ingestion engine (BUILT)
├── server.js                   ← Express API v1 (BUILT — extend to multi-tenant)
├── package.json
├── .env.example
├── .gitignore
├── README.md
│
├── src/                        ← Ingestion engine modules (BUILT)
│   ├── drive-connector.js      (REPLACE with s3-connector.js)
│   ├── text-extractor.js       ✓
│   ├── programme-detector.js   ✓ (23 Zenex clusters)
│   ├── claude-classifier.js    ✓
│   └── eqs-scorer.js           ✓
│
├── web/
│   └── index.html              ← Zenex SPA v1 (BUILT — supersede with React)
│
├── api/                        ← Multi-tenant API (BUILD NEXT)
│   ├── middleware/
│   │   ├── tenant.js           ← Subdomain → tenant context
│   │   ├── auth.js             ← Cognito JWT validation
│   │   └── permissions.js      ← Role-based route guards
│   ├── routes/
│   │   ├── auth.js
│   │   ├── records.js
│   │   ├── classify.js
│   │   ├── queue.js
│   │   ├── knowledge.js
│   │   ├── synthesis.js
│   │   └── admin.js
│   └── services/
│       ├── ai.js               ← Unified AIService (Sonnet + Bedrock + fallback)
│       ├── s3.js               ← S3 connector replacing drive-connector
│       ├── sqs.js              ← Job queue publisher
│       └── db.js               ← Tenant-aware DB connection pool
│
├── frontend/                   ← React SPA (BUILD NEXT)
│   ├── src/
│   │   ├── App.jsx
│   │   ├── auth/               ← Login, Signup, ForgotPassword
│   │   ├── screens/            ← One file per screen (13 screens)
│   │   ├── components/         ← Shared UI components
│   │   ├── hooks/              ← useAuth, useTenant, useRecords
│   │   ├── services/           ← API client
│   │   └── theme/              ← Tenant-aware CSS variables
│   └── public/
│
├── infra/                      ← AWS CDK stacks (BUILD NEXT)
│   ├── stacks/
│   │   ├── TenantStack.ts      ← S3 + Cognito + SQS per tenant
│   │   ├── ApiStack.ts         ← ECS + ALB + Route53
│   │   ├── DatabaseStack.ts    ← RDS + per-schema init
│   │   └── FrontendStack.ts    ← S3 static + CloudFront per tenant
│   └── bin/
│       └── evidenceos.ts
│
├── db/
│   ├── migrations/             ← SQL migration files
│   │   ├── 001_master_tenants.sql
│   │   ├── 002_tenant_schema_template.sql
│   │   └── 003_zenex_seed_data.sql
│   └── seeds/
│       └── zenex_mock_records.sql
│
└── .github/
    └── workflows/
        ├── deploy-api.yml
        └── deploy-frontend.yml
```

---

## IMMEDIATE OPERATING PRINCIPLES FOR ALL BUILDS

1. Every database query includes tenant_id in the WHERE clause. No exceptions.
2. Every S3 operation uses the tenant-specific bucket from req.tenant.s3_bucket.
3. Every Claude API call logs input tokens, output tokens, and latency to ingestion_jobs.
4. No credentials in source code. All secrets from AWS Secrets Manager.
5. All queue items resolved by a human are logged with resolver ID and timestamp.
6. Protocol amendments 1–6 are enforced in the classification prompt. They are not optional.
7. SROI calculations never use unaudited cost data. Gate this at the scoring level.
8. The Optima demo (AuxeiraOptimaDemo2.html) is the design quality standard. Do not build below it.
9. The platform brand is Auxeira. The product brand is EvidenceOS. Client logos appear in the header.
10. When in doubt, check the spec files in the ZenOS repository before writing new logic.


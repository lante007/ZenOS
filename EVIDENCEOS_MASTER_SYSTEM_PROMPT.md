# EVIDENCEOS — MASTER SYSTEM PROMPT
## Auxeira · Evidence Intelligence Infrastructure for Philanthropy
## Version 1.1 · July 2026 · CONFIDENTIAL BUILD SPECIFICATION

---

## PLATFORM IDENTITY

EvidenceOS is a commercial multi-tenant SaaS platform developed by Auxeira that
converts institutional evaluation archives into structured, scored, audience-
calibrated evidence intelligence. Each client organisation operates on an isolated
tenant at their own subdomain (zenex.auxeira.com, optima.auxeira.com).

The platform brand is Auxeira. The product brand is EvidenceOS.
Tagline: Evidence intelligence infrastructure for philanthropy.

Three proprietary frameworks underpin all classification logic (full specifications
in the ZenOS repository at github.com/lante007/ZenOS):

1. ADEI Classification Taxonomy v2.1 — 55 fields across three layers
   (L1: 9 administrative, L2: 25 evidence, L3: 21 intelligence)

2. Evidence Quality Score (EQS) Scoring Logic v0.2
   Formula: Rigour (35%) + Data Quality (20%) + Transparency (15%)
           + Replicability (15%) + Context Relevance (15%)
   Tiers: ≥3.5 Tier 1 (board-citable) | 2.5–3.49 Tier 2 | 1.5–2.49 Tier 3 | <1.5 Excluded
   Research Studies do not receive EQS scores.

3. Three-Capital Valuation Framework
   Financial Capital → Evidence Capital → Decision Capital → EROI → Institutional Capital

Six protocol amendments are active and non-negotiable:
PA1: Null findings at same confidence tier as positive findings
PA2: Process evaluations never receive causal attribution
PA3: SROI cost inputs from audited financials or approved Proxy Library only
PA4: Confidence tiers disaggregated by unit of analysis
PA5: Non-significant tested variables explicitly reported
PA6: Decision relevance by asymmetry (assumption-challenging outranks confirming)

---

## TECHNOLOGY STACK

Frontend: React 18 SPA. One codebase, per-tenant build via environment variables
(REACT_APP_TENANT, REACT_APP_PRIMARY_COLOR, REACT_APP_LOGO_URL).
Deployed to separate S3 static bucket per tenant. CloudFront per subdomain.

Backend: Node.js 20 / Express 4. Multi-tenant middleware routes every request
via subdomain parsing. Deployed on AWS ECS Fargate (us-east-1).

AI Classification:
- PRIMARY: Anthropic claude-sonnet-4-6 (Anthropic API, not Bedrock)
  Temperature 0 for classification, 0.3 for knowledge products
  Max tokens: 2000 classification, 600 knowledge products
- TIER 2 RESOLUTION: AWS Bedrock Claude Haiku (us-east-1)
  For fields with confidence < 0.60
- TIER 3: Expert queue (Organisation Lead per tenant). Max 10 items per batch.

Database: AWS RDS PostgreSQL 15 (us-east-1). One cluster.
Separate schema per tenant. Schema = tenant slug. (zenex, optima, float)

Storage: AWS S3. Separate bucket per tenant (us-east-1).
Convention: auxeira-evidenceos-{tenant-slug}
Structure per bucket:
  raw/documents/      ← source files (private, AES-256 encrypted)
  processed/text/     ← extracted text
  processed/records/  ← full ADEI JSON records
  queue/              ← expert queue exports
  exports/knowledge/  ← generated audience briefs
  exports/reports/    ← quarterly packs, CSV exports

Queue: AWS SQS. One queue per tenant: evidenceos-classify-{tenant-slug}
Auth: AWS Cognito. One User Pool per tenant.
Secrets: AWS Secrets Manager. No credentials in code.
Monitoring: AWS CloudWatch (us-east-1)
DNS: Route 53. Wildcard cert *.auxeira.com via ACM.

---

## USER HIERARCHY AND PERMISSIONS

GUARDRAIL: There are exactly four user levels inside each tenant.
Board members and trustees do not have system access under any circumstances.
They receive a prepared quarterly PDF pack, reviewed by the Organisation Lead
and distributed through existing board communication channels.
CEOs do not administer the system. They have a read-only executive view.

---

### LEVEL 0 — AUXEIRA FOUNDER CONSOLE (Emmanuel Luthuli only)
URL: admin.auxeira.com
This is Emmanuel's personal console. It is not a generic admin tier.
It does not appear in client-facing documentation.

Capabilities:
- Create, configure, suspend, and delete tenant organisations
- View all tenant dashboards, corpora, and API usage
- Set per-tenant feature flags (federated network on/off, SROI module,
  public corpus, max documents, trial expiry)
- Monitor real-time classification jobs across all tenants
- View Anthropic and Bedrock API costs per tenant
- Impersonate any tenant user for support (all impersonation is logged)
- Manage the Auxeira SROI Proxy Library and sector benchmark dataset
- Access the federated intelligence layer across all participating tenants
- Publish EQS standard updates and taxonomy version changes
- View platform billing and MRR

Console screens:
  /admin/platform    — tenant count, MRR, classification volume, API costs
  /admin/tenants     — create/edit/suspend tenants, set subdomain, feature flags
  /admin/jobs        — real-time classification job feed across all tenants
  /admin/corpus      — EQS distribution and tier breakdown per tenant
  /admin/federated   — documents contributed to / consumed from shared network
  /admin/billing     — API tokens, storage, active users per tenant
  /admin/logs        — error log, override audit trail, impersonation log

---

### LEVEL 1 — ORGANISATION LEAD (Operational owner at client)
This is the person who runs EvidenceOS day-to-day at the client organisation.
For Zenex: Fatima Adam (Director of Programmes)
For Optima: Aarti Shah (Strategy and Research Lead)
This is NOT the CEO. CEOs are too senior to administer systems.

Capabilities:
- All capabilities of Levels 2 and 3 within their tenant
- Invite, assign roles to, and deactivate users within their organisation
- Configure tenant profile (logo, colours, fiscal year)
- Override AI classifications on any field (unconditional authority)
- Ratify the EQS scoring logic and flag disagreements for Emmanuel's review
- Authorise documents for the federated corpus
- Generate and approve the quarterly Trustee Evidence Pack (PDF) for distribution
  outside the system via existing board channels
- Access the full audit log of all user actions within their tenant
- Commission new evaluations (TOR generation)
- Configure SROI proxy value overrides for their organisation

---

### LEVEL 2 — EVIDENCE ANALYST
Typical users: Programme officers, research assistants

Capabilities:
- Upload documents and trigger classification
- View all intelligence records (full 55-field detail)
- Run cross-portfolio queries
- Add evidence gap notes and commissioning guidance flags
- Cannot override AI classification (that is Level 1 authority)
- Cannot generate knowledge products (that is Level 3)
- Cannot access the Fatima queue items until Level 1 assigns them

---

### LEVEL 3 — COMMUNICATIONS MANAGER
Typical users: Ruth Rakosa (Zenex), Communications staff

Capabilities:
- Generate audience-calibrated knowledge products from classified records
- View evidence summaries (not full 55-field raw data)
- Download and share knowledge products externally
- View the Evidence Health Score and portfolio KPIs on the dashboard
- Search the evidence library (read-only, Tier 1 and Tier 2 records only)
- Cannot access raw documents, full EQS dimension scores, or queue items
- Cannot see Financial Capital or EROI figures (visible to Level 1 only)

---

### EXECUTIVE VIEW (CEO — not a login level, a delivery format)
The CEO does not administer the system.
The CEO receives two things:

1. An automated weekly email summary (generated every Monday, 07:00):
   - Evidence Health Score with a one-sentence interpretation
   - Any new Tier 1 documents classified this week
   - Decision Capital instances logged this week
   - Queue items pending (count only, not detail)
   - One recommended commissioning priority from the gap register
   Delivered via SES to the CEO's email address configured in tenant settings.

2. A clean executive dashboard accessible at {tenant}.auxeira.com/exec
   Protected by a separate low-friction login (email link, no password required).
   Shows: Evidence Health Score, three-capital cascade summary, top five
   findings this quarter, Decision Capital register (plain language).
   No raw data. No configuration. No document detail.
   Mobile-optimised. Loads in under two seconds.

---

### NO BOARD/TRUSTEE SYSTEM ACCESS
Boards and trustees receive the Trustee Evidence Pack (quarterly PDF).
The pack is generated automatically by the system from the classified corpus.
It is reviewed and approved by the Organisation Lead.
It is distributed outside the system through existing board channels (email,
board portal, document sharing) — not through EvidenceOS.
No trustee credentials are created. No board login screen exists.
The system generates the document. Humans distribute it.

---

## APPLICATION SCREENS

All screens are role-gated as specified above.

### Tenant Landing Page (/{tenant}.auxeira.com)
This is the first page any visitor sees at a client subdomain.
It must feel like an extension of the client's own website, not a SaaS product.

Design requirements:
- Client logo: prominent, full-size, from S3 bucket
- Client brand colours: primary and secondary from tenant configuration
- Single headline: "{Organisation Name} Evidence Intelligence"
- One subheadline: maximum 12 words, specific to the organisation's context
  (e.g. "Zenex Foundation · Foundation Phase evidence, classified and decision-ready")
- One CTA button: "Sign In" — routes to /login
- No Auxeira marketing copy. No feature lists. No pricing.
- Small footer line: "Powered by Auxeira EvidenceOS" in grey
- No navigation. No menu. Just the organisation's identity and a door in.

Example for Zenex:
  [ZENEX FOUNDATION LOGO — orange/purple]
  Zenex Foundation Evidence Intelligence
  Thirty years of Foundation Phase evidence, classified and decision-ready.
  [SIGN IN]
  Powered by Auxeira EvidenceOS

---

### Authentication Screens (/login, /forgot-password, /verify)
Cognito Hosted UI styled to match tenant branding.
Login: email + password. Organisation Lead can enable Google SSO.
JWT tokens stored in memory only. Never localStorage.
Role-based redirect on successful login:
  Level 1 → /dashboard (full view)
  Level 2 → /records (evidence library)
  Level 3 → /knowledge (knowledge products)
  CEO exec link → /exec (executive view)

---

### Dashboard (/dashboard) — Level 1 only
Evidence Health Score (EQS aggregate, graded A–F)
Three-Capital Cascade: Financial Capital → Evidence Capital → Decision Capital → EROI
Tier distribution chart
Decision Capital register (confirmed instances with reach data)
Evidence Currency alerts (documents entering AGING or HISTORICAL status)
Portfolio coverage map (programmes with/without endline data)
Queue badge (items pending expert review)
Recent activity feed
Quarterly Trustee Pack status (generated / pending review / sent)

---

### Evidence Library (/records) — Level 1 and Level 2
Searchable, filterable table of all classified intelligence records
Filters: tier, document type, phase, province, year, programme, audience
Full 55-field detail modal per record
Parent-child cluster view
Export: CSV, JSON

---

### Classify (/classify) — Level 1 and Level 2
Drag-drop upload → S3 → SQS → ingestion engine
S3 folder sync (batch classify all new documents in bucket prefix)
Real-time 8-step pipeline progress view
Settings: institution, taxonomy version, SROI compliance gate

---

### Expert Review Queue (/queue) — Level 1 only
Low-confidence classifications pending Organisation Lead ratification
Per-item: field name, Claude recommendation, confidence, alternatives
Actions: confirm, select alternative, override with custom value
Bulk confirm all recommended values
Inter-rater reliability trend (AI vs expert agreement over time)
Queue target: fewer than 10 items per session

---

### Knowledge Products (/knowledge) — Level 1 and Level 3
Select a classified record (Tier 1 and Tier 2 only)
Select audience (6 options: Trustee, CEO, DBE National, Provincial HOD,
Co-Funder, Sector Peer)
Generate brief (Claude claude-sonnet-4-6, ~3 seconds)
Copy, download, or submit for Level 1 approval before external distribution
Trustee Evidence Pack generation: button triggers quarterly PDF build from corpus

---

### Evidence Translation (/translation) — Level 1 and Level 3
Eight-touchpoint communications journey per evaluation:
Research publication → Executive brief → Policy brief → Stories brief →
LinkedIn post → Infographic brief → Webinar outline → Conference abstract
Auto-generates all eight from a single classified record

---

### Strategic Synthesis (/synthesis) — Level 1 only
Cross-portfolio query: "What does all our coaching evidence show?"
Returns synthesised findings with confidence ratings and citation chain
Every finding linked to its source intelligence record
Powered by Claude claude-sonnet-4-6 with corpus summaries (not raw text)

---

### Portfolio Optimizer (/optimizer) — Level 1 only
Investment slider by programme phase
SROI calculation from Proxy Library and audited cost data
Counterfactual modelling
Evidence gap visualisation
Commissioning priority matrix

---

### Provenance Record (/provenance) — Level 1 only
Full audit chain for any classified claim:
Source → Extraction → Classification → EQS scoring → Expert override → Publication
Every step timestamped and signed
Exportable as provenance certificate

---

### Executive View (/exec) — CEO only (email-link auth, no password)
Evidence Health Score
Three-Capital cascade summary
Top five findings this quarter
Decision Capital register (plain language)
Mobile-optimised. No configuration. No raw data.

---

### Settings (/settings) — Level 1 only
Organisation profile (name, logo, colours, fiscal year, CEO email for weekly summary)
User management (invite, assign role, deactivate)
SROI proxy overrides
Federated corpus settings
Trustee Pack distribution list (email addresses, send schedule)
API key for external integrations (read-only)
Audit log

---

## SUPERADMIN CONSOLE — admin.auxeira.com — EMMANUEL ONLY

Platform Dashboard
Tenant Manager (create/edit/suspend, set subdomain, tier, feature flags)
Classification Monitor (real-time SQS feed, failed jobs, API costs by tenant)
Federated Network Console
Billing and Usage (per-tenant API tokens, storage, users, feature tier)
System Health (RDS, S3, ECS, SQS status)

---

## AI BACKEND — CONFIGURATION

All AI calls route through a single AIService module:
- Model selection by task type
- Retry: 3 attempts with exponential backoff on 429/529
- Token counting and cost logging per tenant
- JSON schema validation before any write
- Fallback to Tier 3 queue on consecutive failures

Classification: claude-sonnet-4-6, temp 0, max 2000 tokens
Knowledge product: claude-sonnet-4-6, temp 0.3, max 600 tokens
Synthesis: claude-sonnet-4-6, temp 0.2, max 3000 tokens
Tier 2: Bedrock claude-haiku, temp 0, max 200 tokens

Six protocol amendments enforced in all classification prompts. Non-negotiable.

---

## DESIGN STANDARD

Primary design reference: AuxeiraOptimaDemo2.html (the Optima demo).
This sets the quality bar for all components, typography, and interactions.

Auxeira Platform Palette:
--navy: #0A1628 | --teal: #00B4D8 | --white: #F5F2EE
--navy-mid: #0F2040 | --gray: #8A9BB5

Tenant Theming (overrides):
Zenex: --primary: #EF7218 | --secondary: #311F47 | logo from S3
Optima: TBD from Optima brand guide

Typography: Cormorant Garamond (display) + DM Sans (body)
Responsive: 1024px desktop minimum. /exec is mobile-optimised.

---

## REPOSITORY STRUCTURE (github.com/lante007/ZenOS)

```
ZenOS/
├── adei-ingest.js              ← CLI ingestion engine (BUILT)
├── server.js                   ← Express API v1 (BUILT — extend to multi-tenant)
├── package.json
├── .env.example
├── EVIDENCEOS_MASTER_SYSTEM_PROMPT.md
│
├── src/                        ← Ingestion modules (BUILT)
│   ├── text-extractor.js       ✓
│   ├── programme-detector.js   ✓ (23 Zenex programme clusters)
│   ├── claude-classifier.js    ✓
│   └── eqs-scorer.js           ✓
│
├── web/index.html              ← Zenex SPA v1 (BUILT — supersede with React)
│
├── api/                        ← Multi-tenant API (BUILD NEXT)
│   ├── middleware/
│   │   ├── tenant.js           ← subdomain → tenant context
│   │   ├── auth.js             ← Cognito JWT validation
│   │   └── permissions.js      ← role-based route guards
│   ├── routes/
│   │   ├── records.js
│   │   ├── classify.js
│   │   ├── queue.js
│   │   ├── knowledge.js
│   │   ├── synthesis.js
│   │   └── admin.js
│   └── services/
│       ├── ai.js               ← unified AIService
│       ├── s3.js               ← replaces drive-connector
│       ├── sqs.js
│       └── db.js               ← tenant-aware connection pool
│
├── frontend/                   ← React SPA (BUILD NEXT)
│   ├── src/
│   │   ├── screens/            ← one file per screen
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── services/           ← API client
│   │   └── theme/              ← tenant CSS variables
│   └── public/
│
├── infra/                      ← AWS CDK us-east-1 (BUILD NEXT)
│   ├── TenantStack.ts          ← S3 + Cognito + SQS per tenant
│   ├── ApiStack.ts             ← ECS + ALB + Route53
│   ├── DatabaseStack.ts        ← RDS + per-schema init
│   └── FrontendStack.ts        ← S3 static + CloudFront per tenant
│
└── db/
    └── migrations/
        ├── 001_master_tenants.sql
        ├── 002_tenant_schema_template.sql
        └── 003_zenex_seed_data.sql
```

---

## NON-NEGOTIABLE BUILD PRINCIPLES

1. Every database query includes tenant_id. No exceptions.
2. Every S3 operation uses the tenant-specific bucket. Never cross-tenant.
3. Every Claude API call logs tokens and latency to ingestion_jobs.
4. No credentials in source code. AWS Secrets Manager only.
5. Board members and trustees have zero system access. Zero.
6. CEOs receive the executive view by email link. Not by system administration.
7. The landing page per subdomain feels like the client's own website.
8. Protocol amendments 1–6 enforced in every classification prompt.
9. The Optima demo (AuxeiraOptimaDemo2.html) is the design quality standard.
10. The platform brand is Auxeira. The product is EvidenceOS. Client logos lead.
11. All infrastructure in us-east-1.

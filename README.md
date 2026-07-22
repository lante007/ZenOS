# ADEI Ingestion Engine v1.0
## Auxeira EvidenceOS — Evidence intelligence infrastructure for philanthropy

### Quick start (Gitpod / Ona / Local)

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env with your credentials

# 3. Place your Google Drive service account JSON
# (Download from Google Cloud Console → Service Accounts)
# Save as: service-account.json

# 4. Test against single Funda Wande document
node adei-ingest.js \
  --file-id 1LMWbo9vSgSRwEhpydUA72Wp3gXrkuxSc \
  --institution "Zenex Foundation" \
  --mode single \
  --verbose

# 5. Run full batch against Zenex archive
node adei-ingest.js \
  --folder-id 11kkaxcsqeDOsFAkBEEGk4dQ_n5imSi-J \
  --institution "Zenex Foundation" \
  --verbose
```

### What this produces

For each document classified:
- `/output/<file-id>.json` — Full 55-field ADEI intelligence record
- `/output/batch-summary-<id>.json` — Batch statistics
- `/output/batch-report-<id>.csv` — One row per document with key fields

### The 8-step pipeline

```
1. Intake           → Download from Google Drive, validate type
2. Rights check     → PII scan, confidentiality flag
3. Text extraction  → PDF (pdf-parse), DOCX (mammoth), PPTX (XML)
4. Programme detect → Match against 23 Zenex programme clusters
5. Claude classify  → Anthropic Claude Sonnet, full 55-field taxonomy
6. EQS scoring      → Five-dimension quality score (Taxonomy v2.1)
7. L3 computation   → Evidence Capital, half-life, commissioning standards
8. Write output     → JSON record + batch CSV report
```

### Three-tier resolution (never blocks the batch)

- **Tier 1** (~60%): Deterministic rules from filename and taxonomy
- **Tier 2** (~35%): Would call AWS Bedrock Claude Haiku (af-south-1)
- **Tier 3** (<10%): Fatima queue — low-confidence fields flagged for review

### Files needed in your environment

```
adei-ingest.js          ← Main entry point
src/
  drive-connector.js    ← Google Drive API
  text-extractor.js     ← PDF/DOCX/PPTX text extraction
  programme-detector.js ← 23 Zenex programme clusters
  claude-classifier.js  ← Anthropic Claude Sonnet classification
  eqs-scorer.js         ← EQS five-dimension scoring
.env                    ← Your credentials (from .env.example)
service-account.json    ← Google Drive service account key
package.json
```

### ADEI Taxonomy v2.1 — EQS Scoring

```
Formula: EQS = (Rigour × 0.35) + (Data Quality × 0.20) + (Transparency × 0.15)
             + (Replicability × 0.15) + (Context Relevance × 0.15)

Tier 1: ≥ 3.5  (HIGH — board citable, SROI eligible)
Tier 2: 2.5–3.49 (MODERATE — publishable)
Tier 3: 1.5–2.49 (LOW — internal use only)
Excluded: < 1.5

Benchmark: SmartStart 2023 = 3.65 (Tier 1)
Funda Wande Midline I (2020) = 4.1 (Tier 1)
```

### Protocol amendments (non-negotiable)

1. Null findings classified at same confidence tier as positive findings
2. SROI inputs from audited financials only
3. Process evaluations never receive causal confidence scores
4. Non-significant tested variables explicitly reported
5. All Claude output validates as JSON before any write

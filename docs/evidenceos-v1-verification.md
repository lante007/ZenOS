# EvidenceOS v1.0 Verification

Date: 2026-07-24
Tenant: Zenex Foundation (`zenex`)

## Live Classification Test

Input object:

- `s3://auxeira-evidenceos-zenex/raw/documents/test-eval.txt`

Classification result:

- Record ID: `ADEI-ZENEX-DF2BBDC6`
- Filename: `test-eval.txt`
- Programme: `Funda Wande`
- Confidence tier: `TIER_1`
- EQS composite: `3.55`
- Expert queue items: `0`

Post-classification verification:

- `/api/records` returned `6` records
- New record present in live RDS
- Processed JSON exists at `processed/records/ADEI-ZENEX-DF2BBDC6.json`
- Processed text exists at `processed/text/ADEI-ZENEX-DF2BBDC6.txt`

## Final Test

- `npm test` passed after the live classification fixes.

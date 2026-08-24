# Pass 3: Province and Year Extraction

Data-completion pass over the 18 `zenex.intelligence_records` rows that had empty `provinces`. All changes were applied directly to the production database (no application code changed) via one-off Node scripts run against `DATABASE_URL`, each wrapped in a transaction with a before/after row count check. No fixes to the DB schema, API, or frontend were made as part of this pass.

## Method

1. Queried for active records with `provinces IS NULL OR provinces = '{}'` — 18 matched.
2. Downloaded each record's source document from `raw/documents/` in S3 (or reused pre-extracted text from `processed/text/` where available).
3. Extracted text locally (`pypdf` for PDFs, macOS `textutil` for `.docx`) and searched for explicit South African province names, distinguishing a document's **own reported scope** (e.g. "the project operates in Eastern Cape and Gauteng") from **citations of other studies** (not applied).
4. For literature/landscape reviews, followed the existing corpus convention (already present on `ADEI-ZE-B3A97FFFE0` and `ADEI-ZE-EB9483578D`) of tagging the union of provinces the review substantively covers.
5. Cross-referenced sibling documents where a record's own source file was unreadable (e.g. the NMI and PENREACH variants of the Notha Ngolwazi project were confirmed via province statements in a related literature-review document, since their own PDFs are scanned images).
6. One record (`ADEI-ZE-B89F30AFA2`, Notha Ngolwazi KICP) was scanned/image-only and unreadable by standard PDF text extraction; ran it through AWS Textract OCR directly against the S3 object (the same OCR path the application's own classification pipeline uses) and found its province from named local municipalities in the OCR'd text.
7. Five records had no site-specific geography anywhere in their source text (national DBE/curriculum-policy documents and literature syntheses with no fieldwork site) — set to `National` rather than left ambiguous.

## Records updated (13 — direct or cross-referenced textual evidence)

| Record | Provinces | Year | Evidence |
|---|---|---|---|
| `ADEI-ZE-2AD94CE65F` Notha Ngolwazi (NMI) | Eastern Cape | 2024 | Cross-referenced (own doc unreadable) |
| `ADEI-ZE-49B35533A7` Landscape analysis: language in early grade maths | Eastern Cape, Gauteng, Limpopo, Western Cape | 2022 | Literature review coverage |
| `ADEI-ZE-526D815A5B` Siyavula Maths Backlogs Pilot | Eastern Cape, Gauteng | 2025 | Explicit programme statement |
| `ADEI-ZE-541BA8C353` Teaching Assistant Programmes in SA | Eastern Cape, Gauteng, KwaZulu-Natal, Limpopo, North West | 2024 | Literature review coverage |
| `ADEI-ZE-6ABFC4DFAC` Zenex Landscape Review of Maths Interventions | Eastern Cape, Free State, Gauteng, KwaZulu-Natal, Mpumalanga, Western Cape | 2016 | Explicit "we reported on" statement |
| `ADEI-ZE-6E7EED5BE3` Coaching in Education review | Eastern Cape, Gauteng, KwaZulu-Natal, Mpumalanga, North West, Western Cape | 2019 | Literature review coverage |
| `ADEI-ZE-70FB97FEA5` M4PT Performance Report | Eastern Cape, Free State, Gauteng, KwaZulu-Natal, Western Cape | 2024 | University partner roster |
| `ADEI-ZE-7F573AC173` Grade 3 Maths Backlogs Project | Eastern Cape | 2024 | Explicit programme statement |
| `ADEI-ZE-945EFE21DB` Post School Bridging Programmes | Gauteng, KwaZulu-Natal | **2017** (was null) | Star Schools stats + report-series narrative dating |
| `ADEI-ZE-C7112E56DD` Notha Ngolwazi (PENREACH) | Gauteng | 2024 | Cross-referenced (own doc unreadable) |
| `ADEI-ZE-DD1E419825` ISASA M&E Programme | Gauteng, KwaZulu-Natal | 2014 | Named venue + named school |
| `ADEI-ZE-EC5789CA14` M4PT Rapid Review (SIIA 2025) | Eastern Cape, Free State, Gauteng, KwaZulu-Natal, Western Cape | 2025 | University partner roster |
| `ADEI-ZE-B89F30AFA2` Notha Ngolwazi (KICP) | KwaZulu-Natal | 2024 | AWS Textract OCR — named municipalities (Ndwedwe, KwaDukuza, iLembe District) |

## Records set to National (5 — no site-specific geography found)

| Record | Reason |
|---|---|
| `ADEI-ZE-166EB7A43F` DBE Early Grade Mathematics Programme (EGMP) Synopsis | National DBE policy synthesis; text explicitly frames itself in terms of "the National DBE offering," no province cited |
| `ADEI-ZE-824262702F` ICT in Early Grade Mathematics Landscape Review | National ICT policy review; only one incidental "Western Cape" example citation |
| `ADEI-ZE-BEC2C202BE` Senior Phase Mathematics Curriculum Review | National curriculum policy review; one weak incidental citation only |
| `ADEI-ZENEX-03113BFA` Learning with technology in low-income households | Literature/conceptual review, no site-specific fieldwork; sole "Western Cape" mention is inside a cited bibliography entry, not the paper's own scope |
| `ADEI-ZENEX-FEC48C62` Perspectives on Learning Backlogs in South African Schooling | National multi-university research series (Zenex-commissioned), no site-specific claims in text |

## Result

Province coverage across all 70 active records: **100%** (was 74% / 52 of 70 before this pass).

## Verification

Post-update smoke test against `/api/stats/cascade` (unaffected by this pass, run as a regression check): Financial 278839394, avg_eqs 2.79, EROI 38, Records 70 — all match the established baseline.

## Addendum: EC2 git push auth

Switched the origin remote from HTTPS (no stored credentials, push was failing) to SSH using a repo-scoped deploy key (`ec2-evidenceos-zenos`, write access enabled). No token or password is stored on the instance; git config user.name/user.email were also set (previously unconfigured, causing commits to auto-attribute to root@ip-...ec2.internal).

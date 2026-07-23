-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- EvidenceOS Zenex Seed Data
-- Five realistic intelligence records for demo and testing
-- Matches the mock data in web/index.html
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- Users
INSERT INTO zenex.users (cognito_sub, email, full_name, role) VALUES
  ('fatima-cognito-sub', 'fatima@zenex.org.za', 'Fatima Adam', 'ORGANISATION_LEAD'),
  ('ruth-cognito-sub', 'ruth@zenex.org.za', 'Ruth Rakosa', 'COMMUNICATIONS'),
  ('sibongile-cognito-sub', 'sibongile@zenex.org.za', 'Sibongile Khumalo', 'CEO_EXEC')
ON CONFLICT (cognito_sub) DO NOTHING;

-- Documents (placeholders — real files live in S3)
INSERT INTO zenex.documents (id, s3_key, filename, mime_type, rights_status, extraction_quality, ingestion_status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'raw/documents/funda-wande-midline-2020.pdf', 'Funda Wande Midline I Evaluation 2020.pdf', 'application/pdf', 'DO_NOT_CITE', 'GOOD', 'COMPLETE'),
  ('11111111-0000-0000-0000-000000000002', 'raw/documents/gde-grade-r-endline-2021.pdf', 'GDE Grade R Maths and Language Endline 2021.pdf', 'application/pdf', 'CLEAR', 'GOOD', 'COMPLETE'),
  ('11111111-0000-0000-0000-000000000003', 'raw/documents/sp-maths-backlogs-final-2023.pdf', 'Senior Phase Mathematics Backlogs Final 2023.pdf', 'application/pdf', 'CLEAR', 'GOOD', 'COMPLETE'),
  ('11111111-0000-0000-0000-000000000004', 'raw/documents/fp-numeracy-isixhosa-2019.pdf', 'Foundation Phase Numeracy isiXhosa Research 2019.pdf', 'application/pdf', 'CLEAR', 'GOOD', 'COMPLETE'),
  ('11111111-0000-0000-0000-000000000005', 'raw/documents/nect-dip-evaluation-2022.pdf', 'NECT District Improvement Programme Evaluation 2022.pdf', 'application/pdf', 'CLEAR', 'GOOD', 'COMPLETE')
ON CONFLICT DO NOTHING;

-- Intelligence Records
INSERT INTO zenex.intelligence_records (
  id, document_id, document_type, evaluation_subtype, programme_name, phase, year,
  provinces, sample_size_learners, sample_size_schools, has_control_group,
  methodology_description,
  key_finding_1, key_finding_2, key_finding_3,
  null_findings_reported, cost_data_present, theory_of_change_explicit,
  external_evaluator, fidelity_reported, dosage_documented,
  publication_status, policy_relevance_score, strategic_value_score,
  nls_alignment, funrs_alignment, dbe_adoption_status,
  audience_relevance, rights_status,
  eqs_composite, eqs_tier,
  dim_methodological_rigour, dim_data_quality, dim_transparency, dim_replicability, dim_context_relevance,
  half_life_rating, evidence_capital_score,
  sroi_eligible, board_citable, classified_by, taxonomy_version
) VALUES
(
  'ADEI-ZF-001',
  '11111111-0000-0000-0000-000000000001',
  'Impact Evaluation', 'RCT', 'Funda Wande', 'Foundation Phase', '2020',
  ARRAY['Eastern Cape'], 1187, 59, true,
  'Matched pair cluster RCT across three Eastern Cape districts. 30 treatment, 29 control schools. 94% learner retention. Midline I assessment at Year 1. Ardington and Meiring, SALDRU/UCT.',
  'Composite effect size of 0.17 SD at Year 1 across Grade 1–2 learners in treatment schools.',
  'Grade 1 phonemic awareness showed strongest effect at 0.28 SD.',
  'Vocabulary null finding (-0.07 SD) attributed to ceiling effect in the EGRA assessment instrument.',
  true, 'ABSENT', true,
  true, true, true,
  'Grey Literature', 5, 5,
  true, true, 'ADOPTED',
  ARRAY['TRUSTEE','CEO','DBE_NATIONAL','PROVINCIAL_HOD','CO_FUNDER','SECTOR_PEER'], 'DO_NOT_CITE',
  4.10, 'TIER_1',
  4.50, 4.20, 4.00, 3.80, 4.30,
  'AGING', 0.820,
  false, true, 'CLAUDE_SONNET', 'v2.1'
),
(
  'ADEI-ZF-002',
  '11111111-0000-0000-0000-000000000002',
  'Impact Evaluation', 'Quasi-experimental', 'GDE Grade R Maths and Language', 'Grade R', '2021',
  ARRAY['Gauteng'], 2100, 42, true,
  'Quasi-experimental design with comparison group. GDE Grade R Maths and Language Improvement Project endline evaluation.',
  'Significant improvement in Grade R mathematics outcomes relative to comparison group.',
  'Teacher practice scores improved by 0.24 SD in treatment schools.',
  null,
  false, 'PROXY', true,
  true, true, true,
  'Grey Literature', 4, 4,
  true, false, 'PILOTED',
  ARRAY['TRUSTEE','CEO','DBE_NATIONAL','PROVINCIAL_HOD'], 'CLEAR',
  3.70, 'TIER_1',
  3.80, 3.90, 3.50, 3.60, 3.80,
  'CURRENT', 0.684,
  false, true, 'CLAUDE_SONNET', 'v2.1'
),
(
  'ADEI-ZF-003',
  '11111111-0000-0000-0000-000000000003',
  'Impact Evaluation', 'Pre-post', 'Senior Phase Mathematics Backlogs', 'Senior Phase', '2023',
  ARRAY['Eastern Cape','KwaZulu-Natal','Limpopo'], 4800, 120, false,
  'Pre-post design without control group. Multi-province assessment of Grade 8-9 mathematics backlog intervention over eight years.',
  'Grade 8–9 backlogs too large to mitigate within available programme resources and time horizon.',
  'Grade 7 intervention window identified as highest-leverage entry point based on assessment data.',
  'R93M invested across 8 years with insufficient systemic change to justify continuation.',
  true, 'PROXY', true,
  true, false, true,
  'Published', 5, 5,
  false, false, 'REFERENCED',
  ARRAY['TRUSTEE','CEO','DBE_NATIONAL'], 'CLEAR',
  3.20, 'TIER_2',
  3.20, 3.50, 3.40, 2.80, 3.10,
  'CURRENT', 0.521,
  false, false, 'CLAUDE_SONNET', 'v2.1'
),
(
  'ADEI-ZF-004',
  '11111111-0000-0000-0000-000000000004',
  'Research Study', 'Literature Review', 'Foundation Phase Numeracy isiXhosa', 'Foundation Phase', '2019',
  ARRAY['Eastern Cape'], null, null, null,
  'Literature review examining the evidence base for mother-tongue mathematics instruction in Foundation Phase, with focus on isiXhosa.',
  'Absence of mother-tongue numeracy materials identified as structural barrier to Foundation Phase mathematics outcomes.',
  null, null,
  false, 'ABSENT', false,
  true, false, false,
  'Published', 3, 3,
  false, false, 'NONE',
  ARRAY['SECTOR_PEER','DBE_NATIONAL'], 'CLEAR',
  null, 'N_A',
  null, null, null, null, null,
  'HISTORICAL', null,
  false, false, 'CLAUDE_SONNET', 'v2.1'
),
(
  'ADEI-ZF-005',
  '11111111-0000-0000-0000-000000000005',
  'Impact Evaluation', 'Quasi-experimental', 'NECT DIP', 'System-Wide', '2022',
  ARRAY['Eastern Cape','KwaZulu-Natal','Limpopo','Gauteng'], 2626, 148, true,
  'Quasi-experimental evaluation of NECT District Improvement Programme across four provinces. 148 schools, pre-post with comparison districts.',
  'Statistically significant improvement in district management capacity scores in 87% of target districts.',
  'Learner attendance improved by 4.2 percentage points in treatment districts.',
  null,
  false, 'PROXY', true,
  true, true, true,
  'Grey Literature', 4, 5,
  false, false, 'ADOPTED',
  ARRAY['TRUSTEE','CEO','DBE_NATIONAL','CO_FUNDER'], 'CLEAR',
  3.50, 'TIER_1',
  3.50, 3.80, 3.40, 3.20, 3.70,
  'CURRENT', 0.636,
  false, true, 'CLAUDE_SONNET', 'v2.1'
)
ON CONFLICT (id) DO NOTHING;

-- Decision Capital instances
INSERT INTO zenex.decision_capital_instances (
  record_id, tier, description, organisation,
  financial_value_rand, learners_affected, reach_description, confirmed_at
) VALUES
(
  'ADEI-ZF-003', 'TIER_1',
  'Zenex board held all new Senior Phase mathematics investments in 2024. Decision directly informed by evaluation evidence that Grade 8–9 backlogs were too large to mitigate within available resources.',
  'Zenex Foundation Board',
  93000000, null, 'R93M of future capital redirected away from demonstrably low-return intervention.', NOW()
),
(
  'ADEI-ZF-001', 'TIER_3',
  'DBE embedded the Funda Wande coaching model in the national Early Grade Reading Programme (EGRP) following RCT evidence. Reaching an estimated 1.2 million learners annually across 9 provinces.',
  'Department of Basic Education',
  null, 1200000, 'National EGRP rollout. Est. 1.2M learners annually.', NOW()
)
ON CONFLICT DO NOTHING;

-- Expert queue items
INSERT INTO zenex.queue_items (
  record_id, document_id, field_name,
  claude_value, claude_confidence,
  system_recommendation, question, alternatives
) VALUES
(
  'ADEI-ZF-001',
  '11111111-0000-0000-0000-000000000001',
  'cost_data_present',
  'ABSENT', 0.45,
  'ABSENT',
  'No cost data appears in the Funda Wande Midline I report. Should this be ABSENT or DEFERRED pending the endline which may include cost analysis?',
  ARRAY['ABSENT','DEFERRED','PROXY']
),
(
  'ADEI-ZF-003',
  '11111111-0000-0000-0000-000000000003',
  'dbe_adoption_status',
  'REFERENCED', 0.52,
  'REFERENCED',
  'DBE officials are cited as aware of the findings but no formal adoption or reference in policy documents is confirmed in this document. REFERENCED or NONE?',
  ARRAY['REFERENCED','NONE','PILOTED']
)
ON CONFLICT DO NOTHING;

SELECT 'Seed data inserted.' AS status;
SELECT id, programme_name, eqs_composite, eqs_tier
  FROM zenex.intelligence_records
  ORDER BY eqs_composite DESC NULLS LAST;

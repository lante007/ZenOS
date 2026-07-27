-- EvidenceOS complete 55-field schema and Zenex seed data enrichment.

ALTER TABLE master.tenants
  ADD COLUMN IF NOT EXISTS organisation_type VARCHAR(30)
    DEFAULT 'FUNDER'
    CHECK (organisation_type IN (
      'FUNDER',
      'IMPLEMENTING_NGO',
      'GOVERNMENT',
      'RESEARCH_INSTITUTION',
      'COLLABORATIVE'
    ));

UPDATE master.tenants
  SET organisation_type = 'FUNDER'
  WHERE slug = 'zenex';

UPDATE master.tenants
  SET organisation_type = 'FUNDER'
  WHERE slug = 'optima';

ALTER TABLE zenex.intelligence_records
  ADD COLUMN IF NOT EXISTS evaluation_design VARCHAR(100),
  ADD COLUMN IF NOT EXISTS unit_of_analysis VARCHAR(100),
  ADD COLUMN IF NOT EXISTS district TEXT[],
  ADD COLUMN IF NOT EXISTS grade VARCHAR(50),
  ADD COLUMN IF NOT EXISTS subject_area VARCHAR(100),
  ADD COLUMN IF NOT EXISTS intervention_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS implementation_period VARCHAR(100),
  ADD COLUMN IF NOT EXISTS population_served TEXT,
  ADD COLUMN IF NOT EXISTS comparison_group TEXT,
  ADD COLUMN IF NOT EXISTS data_sources TEXT,
  ADD COLUMN IF NOT EXISTS baseline_available BOOLEAN,
  ADD COLUMN IF NOT EXISTS endline_available BOOLEAN,
  ADD COLUMN IF NOT EXISTS non_significant_variables TEXT,
  ADD COLUMN IF NOT EXISTS effect_direction VARCHAR(20),
  ADD COLUMN IF NOT EXISTS effect_size_composite NUMERIC(6,3),
  ADD COLUMN IF NOT EXISTS cost_data_source VARCHAR(100),
  ADD COLUMN IF NOT EXISTS audited_financials_used BOOLEAN,
  ADD COLUMN IF NOT EXISTS sroi_ready BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS policy_alignment TEXT,
  ADD COLUMN IF NOT EXISTS decision_relevance TEXT,
  ADD COLUMN IF NOT EXISTS replication_conditions TEXT,
  ADD COLUMN IF NOT EXISTS limitations TEXT,
  ADD COLUMN IF NOT EXISTS equity_considerations TEXT,
  ADD COLUMN IF NOT EXISTS expert_review_required BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS commissioning_organisation_type VARCHAR(30),
  ADD COLUMN IF NOT EXISTS implementing_organisation_type VARCHAR(30),
  ADD COLUMN IF NOT EXISTS implementing_organisation_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS classified_at TIMESTAMPTZ;

UPDATE zenex.intelligence_records SET
  evaluation_subtype = 'RCT',
  evaluation_design = 'Matched pair cluster RCT',
  methodology_description = 'Matched pair cluster RCT across three Eastern Cape districts. 30 treatment and 29 control schools. Randomisation at school level. 1,187 learners assessed at Year 1 midline. 94% learner retention. Conducted by Ardington and Meiring, SALDRU/UCT, March 2020.',
  unit_of_analysis = 'School (cluster)',
  district = ARRAY['Butterworth','Libode','Lusikisiki'],
  grade = 'Grade 1-2',
  subject_area = 'Literacy / Reading',
  intervention_type = 'Structured teacher coaching',
  implementation_period = '2019-2020 (Year 1)',
  population_served = 'Grade 1 and Grade 2 learners, Eastern Cape rural schools',
  comparison_group = '29 control schools, matched pair design',
  null_findings_reported = true,
  non_significant_variables = 'Vocabulary (-0.07 SD) non-significant, attributed to ceiling effect in EGRA instrument. Reported per PA1.',
  effect_direction = 'POSITIVE',
  effect_size_composite = 0.17,
  cost_data_present = 'ABSENT',
  cost_data_source = 'Not reported in this document',
  audited_financials_used = false,
  sroi_ready = false,
  baseline_available = true,
  endline_available = false,
  policy_alignment = 'National Early Grade Reading Programme (EGRP). DBE adoption confirmed. NLS 2024-2030 aligned.',
  decision_relevance = 'Funda Wande coaching model embedded in national EGRP. Estimated 1.2 million learners annually in 9 provinces.',
  assumption_challenged = true,
  evidence_gap_1 = 'Funda Wande endline evaluation (November 2022) not in archive. Highest priority retrieval action.',
  evidence_gap_2 = 'Cost per learner not documented. SROI calculation not possible without audited financials.',
  replication_conditions = 'Structured coaching minimum 30 minutes per teacher per week. Coach quality is primary outcome moderator. Fidelity explains majority of outcome variance.',
  limitations = 'Randomisation at school level introduces intra-cluster correlation not fully disaggregated. Vocabulary null finding may reflect instrument ceiling rather than programme failure. Year 1 midline only - endline results not in this record.',
  equity_considerations = 'Eastern Cape rural focus. Three districts only. Results may not transfer to urban or other provincial contexts without adaptation.',
  classified_at = '2026-07-24T10:00:00Z',
  expert_review_required = false,
  commissioning_organisation_type = 'FUNDER',
  implementing_organisation_type = 'IMPLEMENTING_NGO',
  implementing_organisation_name = 'Funda Wande'
WHERE id = 'ADEI-ZF-001';

UPDATE zenex.intelligence_records SET
  evaluation_subtype = 'Quasi-experimental',
  evaluation_design = 'Quasi-experimental with comparison group',
  methodology_description = 'GDE Grade R Maths and Language Improvement Project endline evaluation. Comparison group design across Gauteng.',
  unit_of_analysis = 'School',
  grade = 'Grade R',
  subject_area = 'Mathematics and Language',
  intervention_type = 'Curriculum coaching and materials',
  population_served = 'Grade R learners, Gauteng',
  null_findings_reported = false,
  effect_direction = 'POSITIVE',
  effect_size_composite = 0.24,
  baseline_available = true,
  endline_available = true,
  classified_at = '2026-07-24T10:00:00Z',
  commissioning_organisation_type = 'FUNDER',
  implementing_organisation_type = 'GOVERNMENT',
  implementing_organisation_name = 'Gauteng Department of Education'
WHERE id = 'ADEI-ZF-002';

UPDATE zenex.intelligence_records SET
  evaluation_subtype = 'Pre-post',
  evaluation_design = 'Pre-post without control group',
  methodology_description = 'Multi-province pre-post assessment of Grade 8-9 mathematics backlog intervention over eight years across Eastern Cape, KZN, and Limpopo.',
  unit_of_analysis = 'Learner',
  grade = 'Grade 8-9',
  subject_area = 'Mathematics',
  intervention_type = 'Curriculum recovery',
  population_served = 'Grade 8 and Grade 9 learners, three provinces',
  null_findings_reported = true,
  effect_direction = 'NEUTRAL',
  baseline_available = true,
  endline_available = true,
  decision_relevance = 'Board held all new Senior Phase mathematics investments in 2024. R93M of capital redirected. Flagship evidence-to-decision case study.',
  assumption_challenged = true,
  limitations = 'No control group. Cannot attribute outcomes causally to intervention. Pre-post design susceptible to maturation and historical effects.',
  classified_at = '2026-07-24T10:00:00Z',
  commissioning_organisation_type = 'FUNDER',
  implementing_organisation_type = 'IMPLEMENTING_NGO',
  implementing_organisation_name = 'Multiple implementing partners'
WHERE id = 'ADEI-ZF-003';

UPDATE zenex.intelligence_records SET
  evaluation_design = 'Literature review and landscape analysis',
  subject_area = 'Numeracy / Mathematics',
  population_served = 'Foundation Phase learners, mother-tongue isiXhosa speakers, Eastern Cape',
  policy_alignment = 'Mother-tongue-based bilingual education policy. CAPS curriculum alignment.',
  classified_at = '2026-07-24T10:00:00Z',
  commissioning_organisation_type = 'FUNDER',
  implementing_organisation_type = 'RESEARCH_INSTITUTION',
  implementing_organisation_name = 'External research team'
WHERE id = 'ADEI-ZF-004';

UPDATE zenex.intelligence_records SET
  evaluation_subtype = 'Quasi-experimental',
  evaluation_design = 'Quasi-experimental with comparison districts',
  methodology_description = 'Quasi-experimental evaluation of NECT District Improvement Programme across four provinces. 148 schools, pre-post with comparison districts.',
  unit_of_analysis = 'District',
  grade = 'Multiple grades',
  subject_area = 'System-wide improvement',
  intervention_type = 'District management capacity building',
  population_served = 'School districts across Eastern Cape, KZN, Limpopo, Gauteng',
  null_findings_reported = false,
  effect_direction = 'POSITIVE',
  baseline_available = true,
  endline_available = true,
  policy_alignment = 'DBE District Development Model. NLS 2024-2030 system-level targets.',
  decision_relevance = 'DBE adopted NECT DIP model nationally. Zenex evidence contributed to scale-up decision.',
  classified_at = '2026-07-24T10:00:00Z',
  commissioning_organisation_type = 'FUNDER',
  implementing_organisation_type = 'COLLABORATIVE',
  implementing_organisation_name = 'National Education Collaboration Trust (NECT)'
WHERE id = 'ADEI-ZF-005';

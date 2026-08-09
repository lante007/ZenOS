'use strict';

// Field taxonomy for the Evidence Intelligence Workspace (Corpus Health +
// Financial Confirmation sections). Kept as one shared definition so the
// completeness endpoint, the financial endpoint, and the generic field-patch
// endpoint can never drift out of sync on what "editable" means.
//
// Only fields with a real CHECK constraint are typed 'enum'. Fields the
// classifier schema documents as enum-like but that hold freeform descriptive
// text in practice (e.g. evaluation_design) are deliberately excluded here
// rather than forced into radio buttons they don't fit.

const CRITICAL_FIELDS = [
  { field: 'methodology_description', label: 'Methodology description', type: 'text', multiline: true },
  { field: 'null_findings_reported', label: 'Null findings reported', type: 'boolean' },
  { field: 'limitations', label: 'Limitations', type: 'text', multiline: true },
  { field: 'effect_size_composite', label: 'Effect size', type: 'text' },
  { field: 'sample_size_learners', label: 'Sample size (learners)', type: 'number' },
  { field: 'baseline_available', label: 'Baseline available', type: 'boolean' },
  { field: 'endline_available', label: 'Endline available', type: 'boolean' },
  { field: 'commissioning_standards_met', label: 'Commissioning standards met', type: 'boolean' },
];

const FINANCIAL_FIELDS = [
  { field: 'total_cost_rand', label: 'Total programme cost (R)', type: 'number' },
  {
    field: 'cost_data_source',
    label: 'Cost data source',
    type: 'enum',
    options: ['AUDITED', 'GRANT_AGREEMENT', 'MANAGEMENT_ACCOUNTS', 'PROXY', 'UNKNOWN'],
  },
  { field: 'cost_per_learner', label: 'Cost per learner (R)', type: 'number' },
  { field: 'financial_year', label: 'Financial year', type: 'text' },
];

const ALL_WORKSPACE_FIELDS = [...CRITICAL_FIELDS, ...FINANCIAL_FIELDS];
const ALLOWED_FIELD_NAMES = ALL_WORKSPACE_FIELDS.map(f => f.field);
const FIELD_MAP = Object.fromEntries(ALL_WORKSPACE_FIELDS.map(f => [f.field, f]));

function fieldDef(name) {
  return FIELD_MAP[name] || null;
}

function isEmpty(value) {
  return value === null || value === undefined || value === '';
}

// Suggested pre-fill: only offered when the record is linked to Optimy
// (optimy_project_id set) and Optimy has supplied a value for this exact
// field in optimy_field_values. No fabricated defaults otherwise.
function optimySuggestion(record, field) {
  if (!record.optimy_project_id) return null;
  const values = record.optimy_field_values || {};
  if (values[field] === undefined || values[field] === null || values[field] === '') return null;
  return { value: values[field], source: 'optimy' };
}

function describeFieldFor(record, def) {
  const current = record[def.field];
  const suggestion = isEmpty(current) ? optimySuggestion(record, def.field) : null;
  return {
    field: def.field,
    label: def.label,
    type: def.type,
    options: def.options || undefined,
    multiline: def.multiline || false,
    current_value: isEmpty(current) ? null : current,
    suggested_value: suggestion ? suggestion.value : null,
    suggested_source: suggestion ? suggestion.source : null,
  };
}

module.exports = {
  CRITICAL_FIELDS,
  FINANCIAL_FIELDS,
  ALL_WORKSPACE_FIELDS,
  ALLOWED_FIELD_NAMES,
  fieldDef,
  isEmpty,
  describeFieldFor,
};

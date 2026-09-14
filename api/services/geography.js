'use strict';

const NINE_PROVINCES = [
  'Eastern Cape',
  'Free State',
  'Gauteng',
  'KwaZulu-Natal',
  'Limpopo',
  'Mpumalanga',
  'Northern Cape',
  'North West',
  'Western Cape',
];

// Defensive backstop: if the classifier (or any other write path, e.g.
// load-processed-records.js's shared unvalidated passthrough -- confirmed
// dead code as of 2026-09, but the guard costs nothing to keep generic)
// ever emits the literal string "National" instead of listing all nine
// provinces, expand it here at the single point of write rather than
// leaving a non-canonical value in the database. Case-insensitive match.
// Any of the nine provinces already present alongside "National" are not
// duplicated, since the return value is always the canonical nine-element
// list.
function expandNationalScope(provinces) {
  if (!Array.isArray(provinces) || provinces.length === 0) return provinces;
  const hasNational = provinces.some(
    p => typeof p === 'string' && p.trim().toLowerCase() === 'national',
  );
  if (!hasNational) return provinces;
  return [...NINE_PROVINCES];
}

module.exports = { expandNationalScope, NINE_PROVINCES };

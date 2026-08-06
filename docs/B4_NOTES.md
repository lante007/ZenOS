# Notes carried forward from Phase B3 into Phase B4

## TRUNCATION BUG (flagged from B3)

Two independent truncation points exist:

1. `extractText()` (src/text-extractor.js) keeps first 8000 + last 2000
   chars of cleaned text. Tables and notes appended after body text are
   mostly discarded for large documents.
2. `classifyDocument()` (src/claude-classifier.js) also truncates to
   `text.substring(0, 12000)`.

For documents > 15000 chars this means only ~13% of content reaches
Claude. NECT PPTX (238k chars) and large DOCX files (171k chars) are
most affected — confirmed empirically during B3 testing: the NECT deck's
238,212 extracted chars and a 171,860-char DOCX body (with 28 tables
appended after it) both get cut down to the same ~10,000-char window,
and in the DOCX case the table content is appended after the body so it
falls almost entirely in the discarded middle section.

### Fix in B4

- Replace the head+tail slice with a structured budget:
  - First 4000 chars (intro/abstract)
  - Last 2000 chars (conclusions)
  - Middle sample 2000 chars (methods/findings)
  - Tables/notes budget 2000 chars (extracted separately, appended)
  - Total: ~10000 chars, better coverage than pure head+tail.
- Remove the duplicate 12000-char truncation in `classifyDocument()`,
  since Pass 1 and Pass 2 each have their own `max_tokens`.

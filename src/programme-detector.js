'use strict';
/**
 * ADEI Programme Detector
 * Identifies which of the 23 Zenex independent cases a document belongs to
 * and whether it is a parent, child, standalone, or research study
 */

const RESEARCH_STUDY_KEYWORDS = [
  'literature review', 'landscape analysis', 'landscape review',
  'learning brief', 'a review of', 'review of', 'landscape study',
  'systematic review', 'scoping review', 'meta-analysis',
];

const PARENT_KEYWORDS = [
  'endline', 'final evaluation', 'final report', 'summative evaluation',
  'impact evaluation', 'endline evaluation', 'summative report',
  'final results', 'outcome evaluation',
];

const CHILD_KEYWORDS = [
  'baseline', 'midline', 'sub-report', 'case studies', 'progress report',
  'inception report', 'theory of change', 'data collection', 'fieldwork report',
  'materials review', 'teacher test', 'stakeholder interview',
  'training of trainers', 'home language materials', 'reflection report',
  'learning brief', 'synopsis', 'learning programme',
];

const PROGRAMME_MAP = [
  {
    name: 'Funda Wande',
    parent_keywords: ['impact evaluation of funda wande', 'funda wande co', 'funda wande coaching intervention'],
    child_keywords: ['funda wande limpopo', 'teaching assistant programmes', 'pathways to learning', 'funda wande literature'],
    phase: 'Foundation Phase',
    expected_subtype: 'Impact',
  },
  {
    name: 'Bala Wande',
    parent_keywords: ['bala wande'],
    child_keywords: [],
    phase: 'Foundation Phase',
    expected_subtype: 'Impact',
  },
  {
    name: 'Notha Ngolwazi',
    parent_keywords: ['notha ngolwazi', 'endline detail report'],
    child_keywords: ['notha ngolwazi', 'baseline evaluation'],
    phase: 'Foundation Phase',
    expected_subtype: 'Impact',
  },
  {
    name: 'SILN',
    parent_keywords: ['systemic improvement in languages and numeracy', 'siln'],
    child_keywords: [],
    phase: 'Foundation Phase',
    expected_subtype: 'Process',
  },
  {
    name: 'Foundation Phase Numeracy isiXhosa',
    parent_keywords: ['foundation phase numeracy in isixhosa', 'numeracy in isixhosa'],
    child_keywords: [],
    phase: 'Foundation Phase',
    expected_subtype: 'Research',
  },
  {
    name: 'GDE Grade R Maths and Language',
    parent_keywords: ['gde gr r maths', 'gde grade r maths and language improvement project - endline', 'gde grade r maths and langauge'],
    child_keywords: ['language case studies', 'teacher test', 'home language materials',
      'stakeholder baseline interview', 'training of trainers', 'twinning schools',
      'midline report', 'consolidated baseline', 'gde gr r maths and language improvement project - consolidated',
      'gde gr r maths and language improvement project - midline'],
    phase: 'Grade R',
    expected_subtype: 'Impact',
  },
  {
    name: 'Grade R Maths Western Cape',
    parent_keywords: ['grade r mathematics project implemented in the western cape - endline',
      'grade r mathematics project implemented in the western cape endline'],
    child_keywords: ['grade r mathematics project implemented in the western cape - midline',
      'grade r mathematics project implemented in the western cape _ review',
      'r-maths materials'],
    phase: 'Grade R',
    expected_subtype: 'Impact',
  },
  {
    name: 'Senior Phase Imfundo Phambili',
    parent_keywords: ['imfundo phambili', 'senior phase imfundo phambili curriculum recovery project final'],
    child_keywords: ['imfundo phambili', 'senior phase imfundo phambili curriculum recovery project baseline',
      'imfundo phambili curriculum recovery revised'],
    phase: 'Senior Phase',
    expected_subtype: 'Impact',
  },
  {
    name: 'Senior Phase EFAL Backlogs',
    parent_keywords: ['senior phase english as a first additional language', 'efal backlogs project baseline',
      'efal backlogs project final'],
    child_keywords: ['efal backlogs', 'efal backlogs project_ssa', 'efal backlogs project - ssa'],
    phase: 'Senior Phase',
    expected_subtype: 'Process',
  },
  {
    name: 'Senior Phase Mathematics Backlogs',
    parent_keywords: ['senior phase mathematics backlogs project final evaluation',
      'senior phase mathematics backlogs project extension'],
    child_keywords: ['senior phase mathematics backlogs project baseline'],
    phase: 'Senior Phase',
    expected_subtype: 'Impact',
  },
  {
    name: 'Siyavula Senior Phase Mathematics',
    parent_keywords: ['siyavula', 'endline evaluation final report', 'siyavula senior phase mathematics backlogs pilot project endline'],
    child_keywords: ['siyavula', 'theory of change review', 'inception report', 'data collection progress'],
    phase: 'Senior Phase',
    expected_subtype: 'Impact',
  },
  {
    name: 'Grade 3 Mathematics Backlogs',
    parent_keywords: ['grade 3 mathematics backlogs project 2024'],
    child_keywords: ['grade 3 mathematics backlogs project 2021'],
    phase: 'Foundation Phase',
    expected_subtype: 'Impact',
  },
  {
    name: 'Grade 4 Mathematics Backlogs',
    parent_keywords: ['grade 4 mathematics backlogs project final'],
    child_keywords: ['grade 4 mathematics backlogs project evaluation baseline'],
    phase: 'Foundation Phase',
    expected_subtype: 'Impact',
  },
  {
    name: 'TaRL Mathematics',
    parent_keywords: ['teaching at the right level', 'tarl'],
    child_keywords: [],
    phase: 'Foundation Phase',
    expected_subtype: 'Impact',
  },
  {
    name: 'NECT DIP',
    parent_keywords: ['national education collaboration trust', 'nect impact and process evaluation', 'nect district improvement programme'],
    child_keywords: ['nect district improvement programme', 'nect dip learning programme', 'nect subject advisor'],
    phase: 'System-Wide',
    expected_subtype: 'Impact',
  },
  {
    name: 'DBE EGMP',
    parent_keywords: ['dbe early grade mathematics programme', 'egmp', 'primary mathematics ltsm and assessments review summative'],
    child_keywords: ['egmp', 'primary mathematics learning and teaching support materials', 'ltsm and assessments review synopsis',
      'assessments learning brief'],
    phase: 'System-Wide',
    expected_subtype: 'Research',
  },
  {
    name: 'PILO',
    parent_keywords: ['programme to improve learning outcomes', 'pilo embedding project summative evaluation report'],
    child_keywords: ['pilo embedding project summative evaluation fieldwork', 'rate of adoption'],
    phase: 'System-Wide',
    expected_subtype: 'Impact',
  },
  {
    name: 'GDE Kha Ri Ambe',
    parent_keywords: ['kha ri ambe', 'gauteng department of education', 'smt languages and mathematics'],
    child_keywords: [],
    phase: 'System-Wide',
    expected_subtype: 'Process',
  },
  {
    name: 'Maths for Primary Teachers M4PT',
    parent_keywords: ['maths for primary teachers', 'm4pt'],
    child_keywords: [],
    phase: 'Teacher Development',
    expected_subtype: 'Process',
  },
  {
    name: 'ISASA and Inkanyezi',
    parent_keywords: ['zenex funded learner programme', 'isasa and inkanyezi', 'process and outcomes final evaluation'],
    child_keywords: ['isasa', 'inkanyezi', 'post school bridging'],
    phase: 'Other',
    expected_subtype: 'Impact',
  },
  {
    name: 'Base 10 Maths',
    parent_keywords: ['base 10 maths project final', 'base 10 project final'],
    child_keywords: ['base 10 maths project baseline', 'base 10 project baseline'],
    phase: 'Foundation Phase',
    expected_subtype: 'Impact',
  },
  {
    name: 'COVID 19 Support',
    parent_keywords: ['grade 2 teachers and parents', 'covid 19', 'communication and support systems'],
    child_keywords: [],
    phase: 'Foundation Phase',
    expected_subtype: 'Research',
  },
  {
    name: 'Post School Bridging',
    parent_keywords: ['evaluation of the zenex foundation post school bridging'],
    child_keywords: [],
    phase: 'Post-School',
    expected_subtype: 'Process',
  },
];

/**
 * Detect which programme a document belongs to and its role
 */
function detectProgramme(filename, textPreview) {
  const combined = (filename + ' ' + textPreview).toLowerCase();

  // 1. Check for research study keywords first
  const isResearchStudy = RESEARCH_STUDY_KEYWORDS.some(k => combined.includes(k));

  // 2. Check each programme
  for (const prog of PROGRAMME_MAP) {
    const isParent = prog.parent_keywords.some(k => combined.includes(k.toLowerCase()));
    const isChild = prog.child_keywords.some(k => combined.includes(k.toLowerCase()));

    if (isParent) {
      return {
        programme: prog.name,
        role: isResearchStudy ? 'research_study' : 'parent',
        phase: prog.phase,
        expectedSubtype: prog.expected_subtype,
        processingOrder: isResearchStudy ? 3 : 1,
      };
    }

    if (isChild) {
      return {
        programme: prog.name,
        role: isResearchStudy ? 'research_study' : 'child',
        phase: prog.phase,
        expectedSubtype: prog.expected_subtype,
        processingOrder: isResearchStudy ? 3 : 2,
      };
    }
  }

  // 3. Standalone detection from filename patterns
  const filenameLC = filename.toLowerCase();
  const isParentByName = PARENT_KEYWORDS.some(k => filenameLC.includes(k));
  const isChildByName = CHILD_KEYWORDS.some(k => filenameLC.includes(k));

  if (isResearchStudy) {
    return { programme: 'Unknown', role: 'research_study', phase: 'Unknown', expectedSubtype: 'Research', processingOrder: 3 };
  }
  if (isParentByName) {
    return { programme: 'Unknown', role: 'parent', phase: 'Unknown', expectedSubtype: 'Impact', processingOrder: 1 };
  }
  if (isChildByName) {
    return { programme: 'Unknown', role: 'child', phase: 'Unknown', expectedSubtype: 'Process', processingOrder: 2 };
  }

  return { programme: 'Unknown', role: 'standalone', phase: 'Unknown', expectedSubtype: 'Unknown', processingOrder: 2 };
}

module.exports = { detectProgramme, PROGRAMME_MAP, RESEARCH_STUDY_KEYWORDS };

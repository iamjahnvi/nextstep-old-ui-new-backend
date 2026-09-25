// =============================================================================
// scraper/extractors/sections.js — STEP 6 section-aware context layer
// =============================================================================
// WHAT: Reusable document-section understanding for extraction: split prepared
//   text into headed sections, classify each section into a generic axis, and
//   locate which section a character offset belongs to. Extractors use it to
//   prefer evidence inside the relevant section (e.g. education signals under
//   an Eligibility heading) without changing what the signals themselves match.
// WHY: The same phrase means different things in different sections — "Class
//   12" under Educational Qualification is decisive; under Application Fee it
//   would be noise. Section context is the cheapest reliable disambiguator,
//   and it reuses the same generic-axis vocabulary as document discovery.
// HEADING DETECTION (deterministic, line-based — works on PDF text where
//   headings survive as short uppercase/numbered lines):
//   - ALL-CAPS lines (3-80 chars, mostly uppercase letters): "ELIGIBILITY".
//   - Numbered headings: "1. Eligibility", "Section 3: Age Limit".
//   - Chapter headings: "CHAPTER – 2 ...".
// AXES: ELIGIBILITY | AGE | DATES | APPLICATION | PATTERN | SYLLABUS | GENERAL.
// CONTRACT:
//   detectSections(text) -> [{ name, axis, start, end }] (offsets into text).
//   classifySection(name) -> axis string.
//   sectionAt(index, sections) -> section object or null.
// GENERICITY: axis keywords are ordinary English words, never exam names.
// =============================================================================

const SECTION_AXES = [
  { axis: "ELIGIBILITY", res: [/eligib\w*/i, /educational\s+qualification/i, /qualification/i, /who\s+can\s+apply/i, /who\s+may\s+apply/i] },
  { axis: "AGE", res: [/age\s+limit/i, /\bage\b/i] },
  { axis: "DATES", res: [/important\s+dates/i, /\bschedule\b/i, /date\s+sheet/i, /time\s+table/i, /key\s+dates/i] },
  { axis: "APPLICATION", res: [/how\s+to\s+apply/i, /application\s+(?:fee|fee\s+and|process)/i, /\bregistration\b/i, /\bapply\b/i] },
  { axis: "PATTERN", res: [/exam\s+pattern/i, /paper\s+pattern/i, /scheme\s+of\s+examination/i, /selection\s+process/i] },
  { axis: "SYLLABUS", res: [/syllabus/i, /syllabi/i] },
];

const MAX_HEADING_CHARS = 80;
const MIN_HEADING_CHARS = 3;
const UPPER_LINE_RE = /^[A-Z][A-Z0-9\s&–—\-(),.':/]{2,79}$/;
// Section numbers stay short ("1.", "1.2", "Section 3") so year-led body
// lines ("2026 session begins…") never read as headings.
const NUMBERED_HEADING_RE = /^(?:chapter|section|part)\s+\S+.*|^\d{1,2}(?:\.\d{1,2})*\.?\s+[A-Za-z].*/i;

function isHeadingLine(line) {
  const text = String(line || "").trim();
  if (text.length < MIN_HEADING_CHARS || text.length > MAX_HEADING_CHARS) return false;
  if (/[.!?]$/.test(text) && !/:$/.test(text)) {
    // Full sentences are body text — unless they end in a colon ("Eligibility:").
    if (!NUMBERED_HEADING_RE.test(text)) return false;
  }
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length === 0) return false;
  const upper = text.replace(/[^A-Z]/g, "").length;
  if (upper / letters.length >= 0.6) return true;
  if (NUMBERED_HEADING_RE.test(text)) return true;
  if (/:$/.test(text) && /^[A-Z]/.test(text)) return true;
  return false;
}

function classifySection(name) {
  const text = String(name || "");
  for (const { axis, res } of SECTION_AXES) {
    if (res.some((re) => re.test(text))) return axis;
  }
  return "GENERAL";
}

function detectSections(text) {
  const source = String(text || "");
  if (!source) return [];
  const lines = source.split("\n");
  const headings = [];
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && isHeadingLine(trimmed)) {
      headings.push({ name: trimmed, start: offset + line.indexOf(trimmed) });
    }
    offset += line.length + 1;
  }
  return headings.map((heading, i) => ({
    name: heading.name,
    axis: classifySection(heading.name),
    start: heading.start,
    end: i + 1 < headings.length ? headings[i + 1].start : source.length,
  }));
}

function sectionAt(index, sections) {
  if (typeof index !== "number" || !Array.isArray(sections)) return null;
  for (const section of sections) {
    if (index >= section.start && index < section.end) return section;
  }
  return null;
}

module.exports = {
  SECTION_AXES,
  MAX_HEADING_CHARS,
  classifySection,
  detectSections,
  sectionAt,
};

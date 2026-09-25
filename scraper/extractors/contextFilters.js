// =============================================================================
// scraper/extractors/contextFilters.js — STEP 6 noise-context suppression
// =============================================================================
// WHAT: Decides whether a numeric education-signal match sits inside
//   non-educational context (a calendar date, an age statement, pagination)
//   and must therefore be discounted. Numbers are cheap; context is the test:
//   "8th September, 2008" is a date that happens to contain an ordinal, not
//   an education level that happens to look like a date.
// WHY: Ordinal education signals (8th/10th/12th) collide with ordinal dates,
//   ages, and page/section numbers. Matching numbers alone turned date
//   boilerplate ("8th September, 2008" as a password example) into
//   educationLevel = 8. Suppression is narrow and local on purpose, and it is
//   asymmetric by design:
//   - Bare ordinals ("8th") are ambiguous: a date marker or month nearby
//     discounts them, because ordinals carry no education context of their own.
//   - Explicit forms ("Class 8", "Class XII", "10+2", "Senior Secondary")
//     carry their own context: only overlap with the noise expression itself
//     (the number IS the age/page number, the ordinal IS the date) discounts
//     them — a date two sentences away never does.
// RULES:
//   date    : ordinal+month adjacency in either order ("8th September",
//             "September 8th") in the same clause; for bare ordinals only,
//             a DOB/password/example marker within 40 chars WITH a month or
//             4-digit year in the same clause.
//   age     : age phrasing overlapping the match ("17 years old", "Page 8"
//             never matches an education signal, but "Page 8th" does).
//   pagination: page/section/chapter numbering overlapping the match, or
//             "-- N of M --" nearby.
//   Sentence boundaries ([.!?]) always break the link between marker and match.
// CONTRACT:
//   noiseContext(collapsed, index, length, matchText)
//     -> null when clean, else { kind: "date"|"age"|"pagination", reason }.
//   filterEducationMatches(collapsed, matches)
//     matches: [{ level, index, length, text }] -> { kept, suppressed } with
//     the suppression reason attached to each suppressed entry.
// GENERICITY: no exam names, no boards, no per-exam branches.
// =============================================================================

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept",
  "oct", "nov", "dec",
];
const MONTH_ALT = MONTHS.join("|");
const ORDINAL_RE = "\\d{1,2}(?:st|nd|rd|th)";
const BARE_ORDINAL_RE = new RegExp(`^${ORDINAL_RE}$`, "i");

// Same-clause ordinal<->month adjacency in either order.
const ORDINAL_MONTH_RE = new RegExp(`(?:${ORDINAL_RE})\\s*,?\\s*(?:${MONTH_ALT})\\b`, "i");
const MONTH_ORDINAL_RE = new RegExp(`(?:${MONTH_ALT})\\s+(?:${ORDINAL_RE})\\b`, "i");
const YEAR_RE = /\b(19|20)\d{2}\b/;
const MONTH_ANY_RE = new RegExp(`\\b(?:${MONTH_ALT})\\b`, "i");
const DATE_MARKER_RE = /\b(born|birth|dob|date of birth|password|example|e\.g\.|illustrat\w*|sample)\b/i;
const AGE_RE = /\b(\d{1,3}\s*years?\s+old|age\s+(?:limit|of|is|:)|aged?\s+\d{1,3}|\b\d{1,3}\s*years?\b)/i;
const PAGINATION_RE = /\b(pages?|sections?|chapters?)\s+\d{1,4}(?:st|nd|rd|th)?\b|--\s*\d+\s+of\s+\d+\s*--/i;
const SENTENCE_BREAK_RE = /[.!?]/;

function clauseAround(text, index, length, radius) {
  // Span around the match clipped at sentence boundaries so markers in
  // neighboring sentences never discount a valid signal.
  const lo = Math.max(0, index - radius);
  const hi = Math.min(text.length, index + length + radius);
  const before = text.slice(lo, index);
  const after = text.slice(index + length, hi);
  const cutBefore = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"));
  const cutAfter = after.search(SENTENCE_BREAK_RE);
  return (
    before.slice(cutBefore + 1) +
    text.slice(index, index + length) +
    (cutAfter === -1 ? after : after.slice(0, cutAfter))
  );
}

function noiseContext(collapsed, index, length, matchText) {
  const text = String(collapsed || "");
  if (!text || typeof index !== "number" || index < 0) return null;
  const len = typeof length === "number" && length > 0 ? length : 0;
  const matched = String(matchText || text.slice(index, index + len));
  const bareOrdinal = BARE_ORDINAL_RE.test(matched.trim());

  // 1. Ordinal glued to a month is a date, whatever the signal shape.
  const near = clauseAround(text, index, len, 30);
  if (ORDINAL_MONTH_RE.test(near) || MONTH_ORDINAL_RE.test(near)) {
    return { kind: "date", reason: "ordinal sits inside a month-date expression" };
  }

  // 2. Bare ordinals need explicit education context: a DOB/password/example
  //    marker sharing the clause with a month or year discounts them.
  //    Explicit "Class N" forms skip this rule — they carry their own context.
  if (bareOrdinal) {
    const clause = clauseAround(text, index, len, 40);
    if (DATE_MARKER_RE.test(clause) && (MONTH_ANY_RE.test(clause) || YEAR_RE.test(clause))) {
      return { kind: "date", reason: "date-example boilerplate (birth/password/example) with month or year" };
    }
  }

  // 3-4. Age/pagination discount only on overlap: the number itself must be
  //    the age or the page number ("Page 8th", "17 years" as the match).
  const tight = text.slice(Math.max(0, index - 8), index + len + 8);
  if (AGE_RE.test(tight)) {
    return { kind: "age", reason: "age phrasing around the number" };
  }
  if (PAGINATION_RE.test(tight)) {
    return { kind: "pagination", reason: "page/section/chapter numbering around the number" };
  }

  return null;
}

function filterEducationMatches(collapsed, matches) {
  const kept = [];
  const suppressed = [];
  for (const match of Array.isArray(matches) ? matches : []) {
    if (!match || typeof match.index !== "number") continue;
    const noise = noiseContext(collapsed, match.index, match.length || 0, match.text);
    if (noise) suppressed.push({ ...match, suppressed: true, reason: noise.reason, kind: noise.kind });
    else kept.push(match);
  }
  return { kept, suppressed };
}

module.exports = {
  MONTHS,
  noiseContext,
  filterEducationMatches,
};

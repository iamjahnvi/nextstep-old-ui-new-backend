// =============================================================================
// scraper/normalizers/dates.js
// =============================================================================
// WHAT: Pure date-candidate parsing/normalization for the extraction layer.
// WHY: Extractors find date *strings* in source text; this module turns them
//   into validated UTC-midnight Dates (or null) so the pipeline never persists
//   an invented or impossible date. No I/O, no DB, no exam knowledge.
// RULES:
//   - Accepted shapes (4-digit year required — never invent a year):
//       ISO      2026-03-12 | 2026/03/12
//       Numeric  12/03/2026 | 12-03-2026 | 12.03.2026  (read as DD/MM/YYYY —
//                Indian official sources use day-first order)
//       Textual  12 January 2026 | 12 Jan 2026 | January 12, 2026 | Jan 12, 2026
//                (ordinal suffixes 1st/2nd/3rd/… allowed, comma optional)
//   - Years must be 2000–2100; day/month ranges validated (incl. leap years).
//   - normalizeRegistration(start, end): parses both; if both parse but
//     end < start the pair is contradictory, so BOTH become null (honest
//     UNKNOWN downstream) instead of an invalid range.
// =============================================================================

const MONTH_INDEX = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7,
  sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

const MONTH_NAMES = Object.keys(MONTH_INDEX)
  .sort((a, b) => b.length - a.length)
  .join("|");

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASH_4_FIRST_RE = /^(\d{4})\/(\d{2})\/(\d{2})$/;
const DMY_RE = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/;
const DMY_TEXT_RE = new RegExp(
  `^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\s*,?\\s*(\\d{4})$`,
  "i"
);
const MDY_TEXT_RE = new RegExp(
  `^(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})$`,
  "i"
);

function isSaneYear(year) {
  return Number.isInteger(year) && year >= 2000 && year <= 2100;
}

// Build a UTC-midnight Date, rejecting impossible calendar dates
// (e.g. 31 Feb) by round-tripping through the Date constructor.
function buildDate(year, monthIndex, day) {
  if (!isSaneYear(year)) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (monthIndex < 0 || monthIndex > 11) return null;
  const date = new Date(Date.UTC(year, monthIndex, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

// parseDateCandidate(string) -> Date (UTC midnight) | null.
function parseDateCandidate(candidate) {
  if (typeof candidate !== "string") return null;
  const text = candidate.replace(/,/g, "").replace(/\s+/g, " ").trim();

  let match = text.match(ISO_RE);
  if (match) {
    return buildDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  match = text.match(SLASH_4_FIRST_RE);
  if (match) {
    return buildDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  match = text.match(DMY_RE);
  if (match) {
    // Day-first by convention (see header); impossible months reject the whole
    // candidate rather than guessing a swap.
    return buildDate(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  }

  match = text.match(DMY_TEXT_RE);
  if (match) {
    return buildDate(Number(match[3]), MONTH_INDEX[match[2].toLowerCase()], Number(match[1]));
  }

  match = text.match(MDY_TEXT_RE);
  if (match) {
    return buildDate(Number(match[3]), MONTH_INDEX[match[1].toLowerCase()], Number(match[2]));
  }

  return null;
}

// normalizeRegistration(startCandidate, endCandidate)
//   Candidates may be date strings (any accepted shape) or Date objects
//   (passed straight through after a sanity check).
//   -> { startDate: Date|null, endDate: Date|null }.
function toDate(candidate) {
  if (candidate instanceof Date) {
    if (Number.isNaN(candidate.getTime())) return null;
    const normalized = new Date(
      Date.UTC(
        candidate.getUTCFullYear(),
        candidate.getUTCMonth(),
        candidate.getUTCDate()
      )
    );
    return isSaneYear(normalized.getUTCFullYear()) ? normalized : null;
  }
  return parseDateCandidate(candidate);
}

function normalizeRegistration(startCandidate, endCandidate) {
  const startDate = toDate(startCandidate);
  const endDate = toDate(endCandidate);
  if (startDate && endDate && endDate < startDate) {
    return { startDate: null, endDate: null };
  }
  return { startDate, endDate };
}

module.exports = {
  MONTH_INDEX,
  parseDateCandidate,
  normalizeRegistration,
  toDate,
};

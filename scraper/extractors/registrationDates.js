// =============================================================================
// scraper/extractors/registrationDates.js
// =============================================================================
// WHAT: Rule-based registration start/end date extraction from prepared text.
// WHY: Registration windows are the highest-signal structured facts on an
//   official page/bulletin. Regex + normalizers/dates.js only — no LLM, no
//   guessing: a date is adopted only if it matches a known shape AND sits in
//   an explicit registration/application context.
// HOW:
//   - HIGH confidence: an explicit start/end label (e.g. "Registration Start
//     Date", "Last date of application") with a parseable date ≤250 chars
//     after the label.
//   - MEDIUM confidence: a "from <date> to <date>" / "between <date> and
//     <date>" range within a registration/application/admission context.
//   - REVISED dates: when several distinct dates compete for one field, an
//     explicitly revision-linked replacement ("last date extended till X",
//     "revised schedule: registration begins Y") wins with its revision
//     context preserved. Bare "extended till X" counts only inside a
//     registration context, and only for the end field.
//   - AMBIGUOUS dates: several plausible dates with no clear revision link
//     yield UNKNOWN for that field — with the competing excerpts preserved
//     as LOW-confidence evidence instead of a guess. UNKNOWN beats a wrong
//     official date, always.
//   - REVISION CLUSTERS (STEP 18): several dates glued after ONE label with
//     only whitespace/punctuation/weekday names between them are successive
//     revisions — the LAST valid date wins at MEDIUM (never HIGH), so review
//     always sees the pick. Sentence breaks, other words, or a BACKWARD time
//     step end the cluster (a glued earlier date belongs to another event,
//     e.g. a notice date — explicit preponement still works via revision
//     verbs), keeping normal single-date behavior untouched.
//   - Anything else (bare dates, contradictory ranges) is ignored — the
//     pipeline records UNKNOWN rather than an invented window.
// CONTRACT:
//   extractRegistrationDates(text, ctx)
//     text: prepared plain text (HTML paragraphs/headings or cleaned PDF text).
//     ctx : provenance { sourceUrl, documentUrl, docType, retrievedAt,
//           section?, extractor? } — extractor tag defaults to
//           "registrationDates.v1".
//   Returns { startDate: Date|null, endDate: Date|null,
//             findings: [{ kind: "start"|"end", confidence, excerpt,
//                          evidence, ambiguous? }] }.
//   Adopted findings carry the winning excerpt; ambiguous findings
//   (ambiguous: true, LOW confidence) carry the competing excerpts so the
//   pipeline can preserve them as evidence for an UNKNOWN field.
//   Dates are UTC-midnight (see normalizers/dates.js); ordering is enforced
//   there — a contradictory pair yields nulls, never an invalid range.
// =============================================================================

const { parseDateCandidate, normalizeRegistration } = require("../normalizers/dates");
const { buildEvidence } = require("./evidence");

const DATE_ATOM =
  "(?:\\d{4}-\\d{2}-\\d{2}|\\d{4}/\\d{2}/\\d{2}|" +
  "\\d{1,2}[\\/.\\-]\\d{1,2}[\\/.\\-]\\d{4}|" +
  "\\d{1,2}(?:st|nd|rd|th)?\\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\s*,?\\s*\\d{4}|" +
  "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\s+\\d{1,2}(?:st|nd|rd|th)?\\s*,?\\s*\\d{4})";

const DATE_RE = new RegExp(DATE_ATOM, "i");
const DATE_GLOBAL_RE = new RegExp(DATE_ATOM, "gi");

const START_LABEL_RE =
  /(?:registration|application|admission|online\s+form)s?\s+(?:begin|begins|commence[sd]?|start[sd]?|open[sd]?)|(?:commencement|beginning|start|opening)\s+of\s+(?:registration|application|admission|online\s+(?:application|form))|(?:registration|application)\s+start\s+date|starting\s+date/gi;

const END_LABEL_RE =
  /last\s+date\s+(?:for|of)|closing\s+date|close\s+of\s+(?:registration|application|admission)|end\s+date|deadline|registration\s+(?:closes?|ends?|will\s+close)|application\s+(?:closes?|ends?|will\s+close)/gi;

const RANGE_RE = new RegExp(
  `(?:from\\s+(${DATE_ATOM})\\s+to\\s+(${DATE_ATOM})|between\\s+(${DATE_ATOM})\\s+and\\s+(${DATE_ATOM}))`,
  "i"
);

const CONTEXT_RE = /regist|applic|admission|online\s+form|important\s+dates|schedule/i;

// Revision verbs that can supersede an earlier date. Generic administrative
// phrasing only — no exam-specific terms. A verb alone never selects a date:
// it must share a sentence-ish span with a field label AND a date, in either
// order. Later dates are NEVER preferred merely for being later. Bare nouns
// ("registration", "application") never attribute a verb-first statement on
// their own — "Revised … registration begins <date>" is start evidence, and
// only an end-specific label makes the same shape end evidence.
const REVISION_VERBS = "extended|revised|reopened|preponed|postponed";
const START_STATEMENT_LABEL =
  "(?:(?:registration|application|admission|online\\s+form)s?\\s+(?:begin|begins|commence[sd]?|start[sd]?|open[sd]?|reopened)|(?:commencement|beginning|start|opening)\\s+of\\s+(?:registration|application|admission|online\\s+(?:application|form))|(?:registration|application)\\s+start\\s+date|starting\\s+date)";
const END_STATEMENT_LABEL =
  "(?:last\\s+date|deadline|closing\\s+date|end\\s+date|(?:registration|application|admission)\\s+(?:closes?|ends?|will\\s+close))";

const WINDOW_CHARS = 250;

// Revision clusters (STEP 18 / BUG-1): official schedules append revisions
// beside the original inside ONE cell or clause ("Sep 25 … Sep 28 … Oct 06 …
// Oct 07") with only whitespace, punctuation, or weekday names between
// consecutive dates. A run of 2+ such dates after one field label is a
// revision cluster: entries supersede left to right, so the LAST valid date
// is current. This is never recency-guessing across fields — only within one
// undifferentiated cluster — and cluster picks carry MEDIUM (positional
// linkage, not grammar) so review always sees them. Sentence boundaries and
// any other words break the run, preserving normal single-date behavior.
const CLUSTER_GLUE_RE = /^(?:[\s,;()]*?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)?[\s,;()]*?)+$/i;
const CLUSTER_BREAK_RE = /[.!?]/;
const CLUSTER_SPAN_CHARS = 200;

function lastDateInCluster(collapsed, firstEnd, firstDate) {
  DATE_GLOBAL_RE.lastIndex = firstEnd;
  let last = null;
  let cursor = firstEnd;
  let floor = firstDate instanceof Date ? firstDate.getTime() : NaN;
  try {
    let match;
    while ((match = DATE_GLOBAL_RE.exec(collapsed)) !== null) {
      const gap = collapsed.slice(cursor, match.index);
      if (CLUSTER_BREAK_RE.test(gap) || !CLUSTER_GLUE_RE.test(gap)) break;
      if (match.index - firstEnd > CLUSTER_SPAN_CHARS) break;
      const parsed = parseDateCandidate(match[0]);
      if (!parsed) break;
      // Revisions supersede forward in time. A backward step (e.g. a notice
      // or publication date glued after the event date) ends the run — it
      // belongs to a different event, not to this revision chain. Explicit
      // preponement still works through revision-verb statements.
      if (!Number.isNaN(floor) && parsed.getTime() < floor) break;
      floor = parsed.getTime();
      last = { date: parsed, end: match.index + match[0].length };
      cursor = last.end;
    }
    return last;
  } finally {
    DATE_GLOBAL_RE.lastIndex = 0;
  }
}

function collapse(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function windowAround(text, index, length = 120) {
  const start = Math.max(0, index - length);
  return text.slice(start, index + length + 200).trim();
}

// First parseable date within `WINDOW_CHARS` after `index`; when it opens a
// revision cluster, the LAST date of the cluster wins with clustered: true
// (caller downgrades confidence — see the cluster rule above).
function firstDateAfter(collapsed, index) {
  const window = collapsed.slice(index, index + WINDOW_CHARS);
  const match = window.match(DATE_RE);
  if (!match) return null;
  const parsed = parseDateCandidate(match[0]);
  if (!parsed) return null;
  const firstEnd = index + match.index + match[0].length;
  const cluster = lastDateInCluster(collapsed, firstEnd, parsed);
  if (cluster) {
    return {
      date: cluster.date,
      excerpt: windowAround(collapsed, index),
      clustered: true,
    };
  }
  return {
    date: parsed,
    excerpt: windowAround(collapsed, index),
    clustered: false,
  };
}

function withCtx(ctx) {
  return {
    sourceUrl: ctx.sourceUrl,
    documentUrl: ctx.documentUrl,
    docType: ctx.docType,
    retrievedAt: ctx.retrievedAt,
    section: ctx.section,
    extractor: (ctx && ctx.extractor) || "registrationDates.v1",
  };
}

function collectLabeled(collapsed, labelRe) {
  const out = [];
  labelRe.lastIndex = 0;
  let label;
  while ((label = labelRe.exec(collapsed)) !== null) {
    const hit = firstDateAfter(collapsed, label.index + label[0].length);
    if (hit) out.push(hit);
    if (label.index === labelRe.lastIndex) labelRe.lastIndex += 1;
  }
  return out;
}

// A revision-statement capture that opens a date cluster resolves to the
// cluster's last date at MEDIUM; single-date statements keep HIGH.
// dateEndIndex is the end offset of the captured date text itself (the walk
// continues from the date, not from the end of the whole statement match).
function clusterAwareCapture(collapsed, dateEndIndex, dateText, excerptIndex) {
  const parsed = parseDateCandidate(dateText);
  if (!parsed) return null;
  const cluster = lastDateInCluster(collapsed, dateEndIndex, parsed);
  if (cluster) {
    return {
      date: cluster.date,
      excerpt: windowAround(collapsed, excerptIndex),
      confidence: "MEDIUM",
    };
  }
  return null;
}

function capturedDateEnd(match, groupIndex) {
  const text = match[groupIndex];
  const start = match.index + match[0].lastIndexOf(text);
  return start + text.length;
}

// Replacement dates stated through revision language tied to a field:
// "<field> … revised/extended … <date>" or "<revised …> <field> … <date>",
// each confined to one sentence-ish span. Returns [{ date, excerpt }].
// Confidence is HIGH: the grammar itself connects field to replacement.
function linkedReplacements(collapsed, statementLabel) {
  const out = [];
  const patterns = [
    `(?:${statementLabel})[^.]{0,150}?\\b(?:${REVISION_VERBS})\\b[^.]{0,150}?(${DATE_ATOM})`,
    `\\b(?:${REVISION_VERBS})\\b[^.]{0,150}?(?:${statementLabel})[^.]{0,150}?(${DATE_ATOM})`,
  ];
  for (const source of patterns) {
    const re = new RegExp(source, "gi");
    let match;
    while ((match = re.exec(collapsed)) !== null) {
      const clustered = clusterAwareCapture(collapsed, capturedDateEnd(match, 1), match[1], match.index);
      if (clustered) {
        out.push(clustered);
      } else {
        const parsed = parseDateCandidate(match[1]);
        if (parsed) {
          out.push({
            date: parsed,
            excerpt: windowAround(collapsed, match.index),
            confidence: "HIGH",
          });
        }
      }
      if (match.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return out;
}

// Bare "extended till <date>" with registration context nearby. End field
// only: extensions idiomatically modify deadlines, and without a field word
// there is no basis to attribute one to a start. MEDIUM: the linkage is
// proximity, not grammar.
function bareExtension(collapsed) {
  const out = [];
  const re = new RegExp(
    `\\bextended\\b\\s+(?:till|to|upto|up\\s+to)\\s+(${DATE_ATOM})`,
    "gi"
  );
  let match;
  while ((match = re.exec(collapsed)) !== null) {
    const before = collapsed.slice(Math.max(0, match.index - 300), match.index);
    const after = collapsed.slice(match.index, match.index + 300);
    if (!CONTEXT_RE.test(before) && !CONTEXT_RE.test(after)) {
      if (match.index === re.lastIndex) re.lastIndex += 1;
      continue;
    }
    const clustered = clusterAwareCapture(collapsed, capturedDateEnd(match, 1), match[1], match.index);
    if (clustered) {
      out.push(clustered);
    } else {
      const parsed = parseDateCandidate(match[1]);
      if (parsed) {
        out.push({
          date: parsed,
          excerpt: windowAround(collapsed, match.index),
          confidence: "MEDIUM",
        });
      }
    }
    if (match.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

// Resolve one field from labeled candidates + statement-derived replacements.
// Single distinct date -> adopted. Several distinct dates -> the single
// statement-derived date wins when there is exactly one; otherwise UNKNOWN
// with every competing excerpt preserved (never a recency guess).
function resolveKind(labeled, stated) {
  const slots = new Map();
  const rank = { HIGH: 2, MEDIUM: 1, LOW: 0 };
  const add = (entry, fromStatement, confidence) => {
    const key = entry.date.getTime();
    if (!slots.has(key)) {
      slots.set(key, {
        date: entry.date,
        excerpts: [],
        fromStatement: false,
        // A fresh slot opens at the sighting's own strength: plain labeled
        // dates HIGH, revision-cluster picks MEDIUM. Later sightings never
        // downgrade it (statement sightings may still upgrade it below).
        confidence: fromStatement ? "HIGH" : confidence,
        statementExcerpt: null,
      });
    }
    const slot = slots.get(key);
    slot.excerpts.push(entry.excerpt);
    // A date seen several ways keeps its strongest linkage; a weaker later
    // sighting never downgrades it.
    if (
      fromStatement &&
      (!slot.fromStatement || rank[confidence] > rank[slot.confidence])
    ) {
      slot.fromStatement = true;
      slot.confidence = confidence;
      slot.statementExcerpt = entry.excerpt;
    }
  };
  // A clustered labeled hit arrives MEDIUM (positional linkage); the slot
  // still keeps its strongest sighting, so a HIGH single-date sighting of
  // the same date elsewhere is never downgraded by it.
  for (const entry of labeled) add(entry, false, entry.clustered ? "MEDIUM" : "HIGH");
  for (const entry of stated) add(entry, true, entry.confidence);

  const distinct = [...slots.values()];
  if (distinct.length === 0) return { date: null, finding: null };
  if (distinct.length === 1) {
    const only = distinct[0];
    return {
      date: only.date,
      finding: {
        // The slot keeps its own linkage strength: plain labeled dates stay
        // HIGH, while revision-cluster picks arrive MEDIUM (downgraded at
        // capture) so review always sees them.
        confidence: only.confidence,
        excerpt: only.fromStatement ? only.statementExcerpt : only.excerpts[0],
      },
    };
  }
  const statedOnly = distinct.filter((slot) => slot.fromStatement);
  if (statedOnly.length === 1) {
    return {
      date: statedOnly[0].date,
      finding: {
        confidence: statedOnly[0].confidence,
        excerpt: statedOnly[0].statementExcerpt,
      },
    };
  }
  return {
    date: null,
    finding: {
      confidence: "LOW",
      ambiguous: true,
      excerpt: distinct.map((slot) => slot.excerpts[0]).join(" | "),
    },
  };
}

function extractRegistrationDates(text, ctx = {}) {
  const collapsed = collapse(text);
  const base = withCtx(ctx);
  const findings = [];
  let startHit = null;
  let endHit = null;

  if (collapsed) {
    const startLabeled = collectLabeled(collapsed, START_LABEL_RE);
    const endLabeled = collectLabeled(collapsed, END_LABEL_RE);
    const startStated = linkedReplacements(collapsed, START_STATEMENT_LABEL);
    const endStated = [
      ...linkedReplacements(collapsed, END_STATEMENT_LABEL),
      ...bareExtension(collapsed),
    ];

    const startResolved = resolveKind(startLabeled, startStated);
    const endResolved = resolveKind(endLabeled, endStated);
    if (startResolved.date) {
      startHit = {
        date: startResolved.date,
        excerpt: startResolved.finding.excerpt,
        confidence: startResolved.finding.confidence,
      };
    } else if (startResolved.finding) {
      findings.push({
        kind: "start",
        confidence: startResolved.finding.confidence,
        ambiguous: true,
        excerpt: startResolved.finding.excerpt,
        evidence: buildEvidence(base, {
          confidence: startResolved.finding.confidence,
          excerpt: startResolved.finding.excerpt,
        }),
      });
    }
    if (endResolved.date) {
      endHit = {
        date: endResolved.date,
        excerpt: endResolved.finding.excerpt,
        confidence: endResolved.finding.confidence,
      };
    } else if (endResolved.finding) {
      findings.push({
        kind: "end",
        confidence: endResolved.finding.confidence,
        ambiguous: true,
        excerpt: endResolved.finding.excerpt,
        evidence: buildEvidence(base, {
          confidence: endResolved.finding.confidence,
          excerpt: endResolved.finding.excerpt,
        }),
      });
    }

    // MEDIUM fallback: explicit "from <date> to <date>" range in context,
    // only for fields with no candidates at all (never over ambiguity).
    if (startHit === null || endHit === null) {
      const noStartCandidates =
        startLabeled.length === 0 && startStated.length === 0;
      const noEndCandidates = endLabeled.length === 0 && endStated.length === 0;
      if (noStartCandidates || noEndCandidates) {
        const range = RANGE_RE.exec(collapsed);
        if (range) {
          const before = collapsed.slice(Math.max(0, range.index - 300), range.index);
          const after = collapsed.slice(range.index, range.index + 400);
          if (CONTEXT_RE.test(before) || CONTEXT_RE.test(after)) {
            const first = parseDateCandidate(range[1] || range[3]);
            const second = parseDateCandidate(range[2] || range[4]);
            if (first && second) {
              const excerpt = windowAround(collapsed, range.index);
              if (noStartCandidates && !startHit) {
                startHit = { date: first, excerpt, confidence: "MEDIUM" };
              }
              if (noEndCandidates && !endHit) {
                endHit = { date: second, excerpt, confidence: "MEDIUM" };
              }
            }
          }
        }
      }
    }
  }

  const { startDate, endDate } = normalizeRegistration(
    startHit ? startHit.date : null,
    endHit ? endHit.date : null
  );

  // A contradictory pair is dropped (normalizer nulls both) — findings only
  // record what was actually adopted.
  if (startDate && startHit) {
    findings.push({
      kind: "start",
      confidence: startHit.confidence,
      excerpt: startHit.excerpt,
      evidence: buildEvidence(base, {
        confidence: startHit.confidence,
        excerpt: startHit.excerpt,
      }),
    });
  }
  if (endDate && endHit) {
    findings.push({
      kind: "end",
      confidence: endHit.confidence,
      excerpt: endHit.excerpt,
      evidence: buildEvidence(base, {
        confidence: endHit.confidence,
        excerpt: endHit.excerpt,
      }),
    });
  }

  return { startDate, endDate, findings };
}

module.exports = {
  extractRegistrationDates,
  DATE_RE,
  DATE_GLOBAL_RE,
};

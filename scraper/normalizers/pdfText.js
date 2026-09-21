// =============================================================================
// scraper/normalizers/pdfText.js
// =============================================================================
// WHAT: Generic PDF text cleaning driven by adapter configuration.
// WHY: Boilerplate (page markers, running headers, agency taglines) differs
//   per source, so the patterns to strip live in the registry adapter
//   (`cleanPatterns`, regex sources) — never in this module. This file
//   contains NO exam-specific strings and NO exam branching: it compiles
//   each configured pattern globally, removes matches, then applies only
//   universal whitespace tidying (collapse 3+ newlines, trim).
// CONTRACT:
//   cleanPDFText(text, patterns) -> cleaned string.
//     text     : raw PDF text (string; anything else is rejected loudly).
//     patterns : array of regex-source strings (adapter.cleanPatterns).
//                Undefined/null/[] means "no configured patterns": text is
//                tidied but otherwise unchanged — nothing is invented.
//   An invalid pattern throws a clear error naming its index (fail fast on
//   bad config rather than silently keeping boilerplate).
// =============================================================================

function cleanPDFText(text, patterns) {
  if (typeof text !== "string") {
    throw new Error("cleanPDFText: text must be a string");
  }
  const list =
    patterns === undefined || patterns === null ? [] : patterns;
  if (!Array.isArray(list)) {
    throw new Error(
      "cleanPDFText: cleanPatterns must be an array of regex sources"
    );
  }

  let out = text;
  list.forEach((source, index) => {
    let re;
    try {
      re = new RegExp(source, "g");
    } catch (error) {
      throw new Error(
        `cleanPDFText: invalid cleanPattern at index ${index} ` +
          `(${JSON.stringify(source)}): ${error.message}`
      );
    }
    out = out.replace(re, "");
  });

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = cleanPDFText;

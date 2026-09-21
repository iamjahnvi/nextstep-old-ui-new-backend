// Legacy entry point — discovery now lives in discovery/sourceDiscovery.js.
// Kept for backward compatibility: same { [label]: { text, url }|null } shape,
// backed by the generic engine (raw hrefs preserved: no base URL to resolve).
const { discoverDocuments } = require("../discovery/sourceDiscovery");

// Generic discovery: match page links against adapter docRules.
// docRules: [{ label, match: [phrase, ...] }] — phrases are case-insensitive
// substrings of link text. Returns { [label]: link|null } (first hit per rule).
function findDocuments(links, docRules) {
  const found = {};
  const rules = Array.isArray(docRules) ? docRules : [];
  for (const rule of rules) {
    if (rule && typeof rule.label === "string") found[rule.label] = null;
  }
  for (const doc of discoverDocuments(links, docRules, null)) {
    found[doc.label] = { text: doc.text, url: doc.url };
  }
  return found;
}

function findInformationBulletin(links) {
  return findDocuments(links, [
    { label: "information-bulletin", match: ["information bulletin"] },
  ])["information-bulletin"];
}

module.exports = findInformationBulletin;
module.exports.findDocuments = findDocuments;
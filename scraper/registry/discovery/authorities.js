// =============================================================================
// scraper/registry/discovery/authorities.js
// =============================================================================
// WHAT: Authority-domain mappings — CONFIGURATION ONLY, no verification logic.
//   Each entry states that a conducting body is known to operate a domain. The
//   verification engine (discovery/sourceVerification.js) reads these entries;
//   nothing here decides anything.
// WHY: Verification must compare candidates against written-down, reviewed
//   facts — never against vibes about a domain, and never invented on the fly.
// VALUE PROVENANCE (nothing invented — every entry mirrors a live-verified
//   scraper adapter's conductingBody + officialWebsite host):
//   - national-testing-agency <- registry/exams/jee-main.js
//   - iit-guwahati            <- registry/exams/gate-2026.js
//   - iit-roorkee             <- registry/exams/jee-advanced.js
// DELIBERATELY ABSENT: NEET/UPSC/SSC and every other body. server/data/exams.js
//   lists their sites, but no scraper adapter has live-verified their
//   conducting-body relationship in this project yet — so candidates pointing
//   at those domains correctly resolve to SOURCE_REVIEW_REQUIRED until a
//   verified mapping is added here with provenance. Absence is the safe default.
// =============================================================================

const { z } = require("zod");

const AuthorityMappingSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    body: z.string().min(1),
    aliases: z.array(z.string().min(1)).default([]),
    domains: z.array(z.string().min(1).regex(/^[a-z0-9.-]+$/)).min(1),
    provenance: z.string().min(1),
  })
  .strict();

const AUTHORITIES = [
  {
    id: "national-testing-agency",
    body: "National Testing Agency (NTA)",
    aliases: ["National Testing Agency", "NTA"],
    domains: ["jeemain.nta.nic.in"],
    provenance: "registry/exams/jee-main.js (conductingBody + officialWebsite host)",
  },
  {
    id: "iit-guwahati",
    body: "Indian Institute of Technology Guwahati",
    aliases: ["IIT Guwahati"],
    domains: ["gate2026.iitg.ac.in"],
    provenance: "registry/exams/gate-2026.js (conductingBody + officialWebsite host)",
  },
  {
    id: "iit-roorkee",
    body: "Indian Institute of Technology Roorkee",
    aliases: ["IIT Roorkee"],
    domains: ["jeeadv.ac.in"],
    provenance: "registry/exams/jee-advanced.js (conductingBody + officialWebsite host)",
  },
];

function validateAuthorities(authorities = AUTHORITIES) {
  return z.array(AuthorityMappingSchema).safeParse(authorities);
}

module.exports = {
  AuthorityMappingSchema,
  AUTHORITIES,
  validateAuthorities,
};

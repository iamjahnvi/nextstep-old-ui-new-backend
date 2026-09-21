// =============================================================================
// DISCOVERY TAXONOMY — server/utils/discovery.js
// =============================================================================
// WHY THIS FILE EXISTS (Phase 2):
//   The MainPage has four discovery filters: Career Type, Exam Type, month,
//   Application Status. Stream is NOT one of them — stream stays on the User
//   profile / Phase 1 eligibility side. This module is the SINGLE source of
//   truth for the Exam-side discovery vocabulary, usable by the Exam schema,
//   validation, seed data and filtering, so canonical strings are never
//   duplicated across files. Backend-only: no frontend copy is created here.
// HOW IT'S USED:
//   - CAREER_TYPES / EXAM_TYPES: controlled enums for the Exam schema.
//   - validate* helpers return { valid, message }, mirroring
//     utils/validation.js conventions.
//   - examOverlapsMonth() is the sanctioned derivation of month relevance
//     from registrationStartDate/registrationEndDate, so no redundant month
//     field is stored on Exam.
//   - getApplicationStatus() is the single shared derivation of application
//     status from the same two dates (canonical OPEN_NOW / UPCOMING / CLOSED).
//     Endpoints map it to the existing recommendExams response strings
//     ("Open"/"Opening Soon"/"Closed") which the frontend depends on.
// =============================================================================

// -----------------------------------------------------------------------------
// 1. CAREER TYPE — the field a student is aiming for.
// Canonical machine-readable UPPER_SNAKE values.
// -----------------------------------------------------------------------------
const CAREER_TYPES = [
    "ENGINEERING",
    "MEDICAL",
    "MANAGEMENT",
    "LAW",
    "GOVERNMENT_JOBS",
    "BANKING_INSURANCE",
    "DEFENCE",
    "TEACHING_EDUCATION",
    "DESIGN_ARCHITECTURE",
    "SCIENCE_RESEARCH",
    "ARTS_HUMANITIES",
    "COMMERCE_FINANCE",
    "IT_COMPUTER_APPLICATIONS",
    "AGRICULTURE",
    "PARAMEDICAL_NURSING",
    "HOTEL_MANAGEMENT_HOSPITALITY",
    "MASS_COMMUNICATION_JOURNALISM",
    "RAILWAYS",
    "SSC",
];

const CAREER_TYPE_LABELS = {
    ENGINEERING: "Engineering",
    MEDICAL: "Medical",
    MANAGEMENT: "Management (MBA/BBA)",
    LAW: "Law",
    GOVERNMENT_JOBS: "Government Jobs (UPSC/State PSC)",
    BANKING_INSURANCE: "Banking & Insurance",
    DEFENCE: "Defence",
    TEACHING_EDUCATION: "Teaching & Education",
    DESIGN_ARCHITECTURE: "Design & Architecture",
    SCIENCE_RESEARCH: "Science & Research",
    ARTS_HUMANITIES: "Arts & Humanities",
    COMMERCE_FINANCE: "Commerce & Finance",
    IT_COMPUTER_APPLICATIONS: "IT & Computer Applications",
    AGRICULTURE: "Agriculture",
    PARAMEDICAL_NURSING: "Paramedical & Nursing",
    HOTEL_MANAGEMENT_HOSPITALITY: "Hotel Management & Hospitality",
    MASS_COMMUNICATION_JOURNALISM: "Mass Communication & Journalism",
    RAILWAYS: "Railways",
    SSC: "SSC (Staff Selection)",
};

// Legacy aliases from the previous taxonomy — mapped forward so old stored
// values and old client queries keep working after the taxonomy expansion.
// - MEDICINE -> MEDICAL (renamed)
// - GOVERNMENT -> GOVERNMENT_JOBS (renamed)
// - DESIGN -> DESIGN_ARCHITECTURE (renamed)
// - SCIENCE -> SCIENCE_RESEARCH (renamed)
// - COMMERCE -> COMMERCE_FINANCE (renamed)
// - SCHOOL -> TEACHING_EDUCATION (school talent/admission exams live here now)
const CAREER_TYPE_ALIASES = {
    MEDICINE: "MEDICAL",
    GOVERNMENT: "GOVERNMENT_JOBS",
    DESIGN: "DESIGN_ARCHITECTURE",
    SCIENCE: "SCIENCE_RESEARCH",
    COMMERCE: "COMMERCE_FINANCE",
    SCHOOL: "TEACHING_EDUCATION",
};

// Dataset mapping notes (guide for the future data-migration phase):
// - ENGINEERING: JEE Main, JEE Advanced, BITSAT, VITEEE, SRMJEEE, GATE
// - MEDICAL: NEET UG, NEET PG, INI CET, GPAT (pharmacy track)
// - LAW: CLAT UG, AILET, CLAT PG
// - SCIENCE_RESEARCH: SOF NSO, SOF IMO, RMO-INMO, INSPIRE-SHE, IIT JAM
// - AGRICULTURE: ICAR AIEEA UG
// - COMMERCE_FINANCE: CA Foundation, CSEET, CMA Foundation
// - MANAGEMENT: IPMAT, JIPMAT, NPAT, CAT, XAT, MAT, CMAT, SNAP, NMAT by GMAC, IIFT
// - DESIGN_ARCHITECTURE: NATA (architecture), NIFT, UCEED, NID DAT
// - DEFENCE: NDA-NA, CDS, AFCAT
// - GOVERNMENT_JOBS: UPSC CSE, SSC CGL
// - BANKING_INSURANCE: IBPS PO, RBI Grade B
// - SSC: (reserved for future SSC CHSL/MTS/GD entries; SSC CGL currently
//   under GOVERNMENT_JOBS for backward compatibility)
// - TEACHING_EDUCATION: NTSE, NMMS, JNVST, AISSEE, UGC NET, CUET UG, CUET PG
//   (school-level talent / admission exams + teaching eligibility + common
//   university entrances until finer-grained careers are assigned)

const normalizeCareerType = (value) => {
    if (typeof value !== "string") return null;
    const upper = value.trim().toUpperCase();
    if (CAREER_TYPES.includes(upper)) return upper;
    const aliased = CAREER_TYPE_ALIASES[upper];
    if (aliased && CAREER_TYPES.includes(aliased)) return aliased;
    return null;
};

const validateCareerType = (value) => {
    if (value === undefined || value === null || value === "") {
        return { valid: true, message: "" }; // absent = legacy doc, allowed
    }
    if (normalizeCareerType(value) === null) {
        return {
            valid: false,
            message: `Career type must be one of: ${CAREER_TYPES.join(", ")}.`,
        };
    }
    return { valid: true, message: "" };
};

// -----------------------------------------------------------------------------
// 2. EXAM TYPE — the nature/category of the exam (separate from Career Type,
// e.g. JEE Main is ENGINEERING + COMMON_NATIONAL_LEVEL_EXAM, an Olympiad is
// SCIENCE_RESEARCH + OLYMPIAD).
// -----------------------------------------------------------------------------
const EXAM_TYPES = [
    "ENTRANCE_EXAM",
    "BOARD_EXAM",
    "RECRUITMENT_EXAM",
    "ELIGIBILITY_TEST",
    "SCHOLARSHIP_EXAM",
    "OLYMPIAD",
    "CERTIFICATION_EXAM",
    "MERIT_BASED_EXAM",
    "ENTRANCE_CUM_SCHOLARSHIP",
    "COMMON_NATIONAL_LEVEL_EXAM",
    "STATE_LEVEL_EXAM",
    "INTERNATIONAL_EXAM",
];

const EXAM_TYPE_LABELS = {
    ENTRANCE_EXAM: "Entrance Exam (UG/PG admission)",
    BOARD_EXAM: "Board Exam (Class 10/12)",
    RECRUITMENT_EXAM: "Recruitment Exam (govt job hiring)",
    ELIGIBILITY_TEST: "Eligibility Test (like TET, NET, SET)",
    SCHOLARSHIP_EXAM: "Scholarship Exam",
    OLYMPIAD: "Olympiad",
    CERTIFICATION_EXAM: "Certification Exam (CA, CS, CFA)",
    MERIT_BASED_EXAM: "Merit-based Exam (no exam, marks-based)",
    ENTRANCE_CUM_SCHOLARSHIP: "Entrance-cum-Scholarship",
    COMMON_NATIONAL_LEVEL_EXAM: "Common/National Level Exam (JEE, NEET, CUET)",
    STATE_LEVEL_EXAM: "State-Level Exam",
    INTERNATIONAL_EXAM: "International Exam (GRE, GMAT, IELTS, TOEFL)",
};

// Legacy aliases from the previous taxonomy.
// - ENTRANCE -> ENTRANCE_EXAM (renamed)
// - SCHOLARSHIP -> SCHOLARSHIP_EXAM (renamed)
// - GOVERNMENT -> RECRUITMENT_EXAM (govt recruitment lives here now)
const EXAM_TYPE_ALIASES = {
    ENTRANCE: "ENTRANCE_EXAM",
    SCHOLARSHIP: "SCHOLARSHIP_EXAM",
    GOVERNMENT: "RECRUITMENT_EXAM",
};

// Dataset mapping notes:
// - OLYMPIAD: SOF NSO, SOF IMO, RMO-INMO
// - SCHOLARSHIP_EXAM: NTSE, NMMS, INSPIRE-SHE
// - RECRUITMENT_EXAM: UPSC CSE, SSC CGL, IBPS PO, RBI Grade B, NDA-NA, CDS, AFCAT
// - ELIGIBILITY_TEST: UGC NET
// - CERTIFICATION_EXAM: CA Foundation, CSEET, CMA Foundation
// - COMMON_NATIONAL_LEVEL_EXAM: JEE Main, JEE Advanced, NEET UG, CUET UG,
//   CUET PG, GATE
// - ENTRANCE_EXAM: everything else (university/private entrances, PG
//   entrances, design/law/management entrances, school admissions)

const normalizeExamType = (value) => {
    if (typeof value !== "string") return null;
    const upper = value.trim().toUpperCase();
    if (EXAM_TYPES.includes(upper)) return upper;
    const aliased = EXAM_TYPE_ALIASES[upper];
    if (aliased && EXAM_TYPES.includes(aliased)) return aliased;
    return null;
};

const validateExamType = (value) => {
    if (value === undefined || value === null || value === "") {
        return { valid: true, message: "" }; // absent = legacy doc, allowed
    }
    if (normalizeExamType(value) === null) {
        return {
            valid: false,
            message: `Exam type must be one of: ${EXAM_TYPES.join(", ")}.`,
        };
    }
    return { valid: true, message: "" };
};

// -----------------------------------------------------------------------------
// 3. MONTH — derived, never stored.
// An exam is relevant to a calendar month iff its registration window
// [registrationStartDate, registrationEndDate] overlaps that month. This is
// the proof that no separate month field is required on Exam.
// monthIndex is 0-based (0 = January), matching Date conventions.
// -----------------------------------------------------------------------------
const examOverlapsMonth = (exam, year, monthIndex) => {
    if (!exam || !Number.isInteger(year) || !Number.isInteger(monthIndex)) return false;
    if (monthIndex < 0 || monthIndex > 11) return false;
    const start = exam.registrationStartDate
        ? new Date(exam.registrationStartDate)
        : null;
    const end = exam.registrationEndDate
        ? new Date(exam.registrationEndDate)
        : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return false;
    }
    const monthStart = new Date(year, monthIndex, 1, 0, 0, 0, 0);
    const monthEnd = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
    return start <= monthEnd && end >= monthStart;
};

// -----------------------------------------------------------------------------
// 4. APPLICATION STATUS — derived, never stored.
// Canonical values for the MainPage discovery filter. Derived from the same
// registrationStartDate/registrationEndDate source of truth, compared against
// a reference instant (defaults to now, same server-local Date convention as
// the rest of the codebase):
//   now <  registrationStartDate -> UPCOMING
//   start <= now <= end           -> OPEN_NOW  (inclusive on both ends)
//   now >  registrationEndDate   -> CLOSED
// Defensive only (schema requires both dates): a missing/invalid bound is
// treated as unbounded on that side, so the helper asserts only what the
// stored dates prove. No "applicationStatus" database field.
// NOTE: endpoints map this to the existing recommendExams response strings
// ("Open"/"Opening Soon"/"Closed") which the frontend depends on — never
// rename the API response.
// -----------------------------------------------------------------------------
const APPLICATION_STATUS = ["OPEN_NOW", "UPCOMING", "CLOSED"];

const APPLICATION_STATUS_LABELS = {
    OPEN_NOW: "Open Now",
    UPCOMING: "Upcoming",
    CLOSED: "Closed",
};

const toFiniteDateOrNull = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const getApplicationStatus = (exam, now) => {
    const reference = toFiniteDateOrNull(now) || new Date();
    const start = exam ? toFiniteDateOrNull(exam.registrationStartDate) : null;
    const end = exam ? toFiniteDateOrNull(exam.registrationEndDate) : null;
    if (start && reference < start) return "UPCOMING";
    if (end && reference > end) return "CLOSED";
    return "OPEN_NOW";
};

module.exports = {
    CAREER_TYPES,
    CAREER_TYPE_LABELS,
    CAREER_TYPE_ALIASES,
    normalizeCareerType,
    validateCareerType,
    EXAM_TYPES,
    EXAM_TYPE_LABELS,
    EXAM_TYPE_ALIASES,
    normalizeExamType,
    validateExamType,
    examOverlapsMonth,
    APPLICATION_STATUS,
    APPLICATION_STATUS_LABELS,
    getApplicationStatus,
};

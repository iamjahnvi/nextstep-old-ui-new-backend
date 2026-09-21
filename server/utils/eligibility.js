// =============================================================================
// ELIGIBILITY HELPERS — server/utils/eligibility.js
// =============================================================================
// WHY THIS FILE EXISTS:
//   Exam eligibility previously lived as a single MongoDB query inside
//   examController.js that (a) compared education levels with a string `$lte`
//   (wrong for mixed "8"/"10"/"Graduate" data), (b) matched streams with an
//   exact `$in` (so exams marked "Any stream" / "General (all streams)" were
//   incorrectly excluded for every user), and (c) ignored subjects entirely.
//   These pure, unit-testable helpers implement the same eligibility system —
//   no new rules invented — but with correct normalization.
// HOW IT'S USED:
//   - isProfileComplete(profile) -> { complete, missing }. Required for a
//     recommendation request: educationLevel, stream, percentage. Age and
//     subjects are stored/accepted but NOT required for completeness.
//   - filterEligibleExams(exams, profile) -> exams the profile is eligible for.
//   - examMatchesStream / userMatchesExamSubjects are exported for testing.
// =============================================================================

const { normalizeEducationLevel, getEducationRank } = require("./educationLevels");

const CANONICAL_STREAMS = ["Science", "Commerce", "Arts/Humanities"];

// Matches exam stream entries that mean "open to every stream", including the
// variants present in the actual dataset. Entries with extra qualifiers in
// parentheses (e.g. "Any stream (Army wing)") are still all-streams entries —
// the parenthesis only clarifies the academy/wing, it does not restrict the
// school stream. "Any stream with Mathematics" also matches every stream on
// the stream axis; its Mathematics requirement is enforced separately by the
// subject check below.
const ALL_STREAMS_REGEX = /any\s*stream|general\s*\(all\s*streams\)/i;

const normalizeStream = (value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const exact = CANONICAL_STREAMS.find(
        (stream) => stream.toLowerCase() === trimmed.toLowerCase()
    );
    return exact || null;
};

const isValidStream = (value) => normalizeStream(value) !== null;

const examMatchesStream = (examStreams, userStream) => {
    const canonicalUserStream = normalizeStream(userStream);
    if (!canonicalUserStream) return false;
    if (!Array.isArray(examStreams)) return false;
    const userLower = canonicalUserStream.toLowerCase();
    return examStreams.some((entry) => {
        if (typeof entry !== "string") return false;
        const trimmed = entry.trim();
        if (!trimmed) return false;
        if (trimmed.toLowerCase() === userLower) return true;
        if (ALL_STREAMS_REGEX.test(trimmed)) return true;
        return false;
    });
};

// -----------------------------------------------------------------------------
// Subjects
// HOW: User subjects are atomic school subjects from the profile form
//   ("Physics", "Accountancy", ...). Exam `subjects` are a mix of atomic names
//   ("Physics"), composite entries ("Mathematics/Biology",
//   "General Ability Test (English + GK)") and generic aptitude topics
//   ("Logical Reasoning"). We tokenize exam subjects, detect which tokens name
//   a real school subject (via the canonical list + aliases), and require at
//   least one overlap with the user's subjects — but ONLY when both sides
//   carry usable data. Exams with no school-subject content skip the check,
//   and users who listed no subjects are never excluded by it.
// -----------------------------------------------------------------------------

// Canonical school subjects (lowercased) matching the profile form options,
// plus aliases for spelling variants used in the exam dataset.
const SUBJECT_ALIAS_TO_CANONICAL = {
    physics: "physics",
    chemistry: "chemistry",
    mathematics: "mathematics",
    maths: "mathematics",
    math: "mathematics",
    biology: "biology",
    botany: "biology",
    zoology: "biology",
    biotechnology: "biology",
    english: "english",
    hindi: "hindi",
    sanskrit: "sanskrit",
    history: "history",
    geography: "geography",
    "political science": "political science",
    economics: "economics",
    accountancy: "accountancy",
    accounting: "accountancy",
    "business studies": "business studies",
    "computer science": "computer science",
    "physical education": "physical education",
    psychology: "psychology",
    sociology: "sociology",
    philosophy: "philosophy",
    "fine arts": "fine arts",
    "home science": "home science",
    "legal studies": "legal studies",
    entrepreneurship: "entrepreneurship",
    "general knowledge": "general knowledge",
    gk: "general knowledge",
    "environmental science": "environmental science",
    "information technology": "information technology",
    "artificial intelligence": "artificial intelligence",
    "data science": "data science",
    "engineering graphics": "engineering graphics",
    agriculture: "agriculture",
    marketing: "marketing",
    "fashion studies": "fashion studies",
    music: "music",
    dance: "dance",
    "informatics practices": "informatics practices",
    "applied mathematics": "applied mathematics",
    statistics: "statistics",
    "business mathematics": "business mathematics",
    "mass media studies": "mass media studies",
    journalism: "journalism",
    anthropology: "anthropology",
    "public administration": "public administration",
    "regional languages": "regional languages",
    "social science": "social science",
    civics: "civics",
    "work experience": "work experience",
    "web application development": "web application development",
    ites: "it/ites",
    retail: "retail",
    tourism: "tourism",
    beauty: "beauty & wellness",
    wellness: "beauty & wellness",
    "food production": "food production",
    banking: "banking & insurance",
    insurance: "banking & insurance",
    "design thinking": "design thinking & innovation",
    "financial markets management": "financial markets management",
    yoga: "yoga",
    french: "french",
    german: "german",
    spanish: "spanish",
    marathi: "marathi",
    gujarati: "gujarati",
    punjabi: "punjabi",
    kannada: "kannada",
    malayalam: "malayalam",
    odia: "odia",
    assamese: "assamese",
    urdu: "urdu",
    "art education": "art education",
    "health education": "health education",
};

const canonicalizeSubject = (value) => {
    if (typeof value !== "string") return null;
    const lower = value.trim().toLowerCase();
    if (!lower) return null;
    return SUBJECT_ALIAS_TO_CANONICAL[lower] || lower;
};

const normalizeUserSubjects = (subjects) => {
    if (!Array.isArray(subjects)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of subjects) {
        if (typeof entry !== "string") continue;
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
    }
    return out;
};

// Split composite exam subject strings into searchable tokens.
const tokenizeExamSubject = (subject) => {
    return String(subject)
        .split(/[\/;,+&()]+/)
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
};

// School-subject phrases named by one exam (canonical keys), including subject
// requirements implied by qualified all-streams entries such as
// "Any stream with Mathematics".
const examSchoolSubjects = (exam) => {
    const found = new Set();
    const subjects = Array.isArray(exam.subjects) ? exam.subjects : [];
    for (const subject of subjects) {
        if (typeof subject !== "string") continue;
        for (const token of tokenizeExamSubject(subject)) {
            for (const alias of Object.keys(SUBJECT_ALIAS_TO_CANONICAL)) {
                if (token.includes(alias)) {
                    found.add(SUBJECT_ALIAS_TO_CANONICAL[alias]);
                }
            }
        }
    }
    const streams = Array.isArray(exam.streams) ? exam.streams : [];
    for (const entry of streams) {
        if (typeof entry !== "string") continue;
        const withMatch = entry.match(/with\s+([a-z\s./+&(),-]+)/i);
        if (withMatch) {
            for (const token of tokenizeExamSubject(withMatch[1])) {
                for (const alias of Object.keys(SUBJECT_ALIAS_TO_CANONICAL)) {
                    if (token.includes(alias)) {
                        found.add(SUBJECT_ALIAS_TO_CANONICAL[alias]);
                    }
                }
            }
        }
    }
    return [...found];
};

const userMatchesExamSubjects = (userSubjects, exam) => {
    const required = examSchoolSubjects(exam);
    if (required.length === 0) return true; // exam names no school subject -> N/A
    const normalized = normalizeUserSubjects(userSubjects);
    if (normalized.length === 0) return true; // user listed none -> do not exclude
    const userCanonical = new Set(
        normalized.map(canonicalizeSubject).filter(Boolean)
    );
    return required.some((subject) => userCanonical.has(subject));
};

// -----------------------------------------------------------------------------
// Profile completeness
// Required: educationLevel (recognised), stream (recognised),
// percentage (number 0-100). Age and subjects are accepted/stored but never
// required here, per Phase 1 spec.
// -----------------------------------------------------------------------------
const isProfileComplete = (profile) => {
    const missing = [];
    const source = profile && typeof profile === "object" ? profile : {};
    if (normalizeEducationLevel(source.educationLevel) === null) {
        missing.push("educationLevel");
    }
    if (normalizeStream(source.stream) === null) {
        missing.push("stream");
    }
    const percentage =
        source.percentage === "" || source.percentage === undefined || source.percentage === null
            ? null
            : Number(source.percentage);
    if (
        percentage === null ||
        !Number.isFinite(percentage) ||
        percentage < 0 ||
        percentage > 100
    ) {
        missing.push("percentage");
    }
    return { complete: missing.length === 0, missing };
};

const examMatchesEducation = (examMinimumEducationLevel, userEducationLevel) => {
    const examRank = getEducationRank(examMinimumEducationLevel);
    const userRank = getEducationRank(userEducationLevel);
    if (examRank === null || userRank === null) return false;
    return userRank >= examRank;
};

const examMatchesPercentage = (exam, userPercentage) => {
    const required =
        exam && exam.eligibility && exam.eligibility.minimumPercentage;
    if (required === undefined || required === null) return true;
    const percentage = Number(userPercentage);
    if (!Number.isFinite(percentage)) return false;
    return percentage >= Number(required);
};

const examMatchesAge = (exam, userAge) => {
    const minimumAge = exam ? exam.minimumAge : null;
    if (minimumAge === undefined || minimumAge === null) return true;
    // Age is optional on the profile: without a verified age the user cannot
    // satisfy an age-gated exam, so it is excluded (other exams still match).
    if (userAge === undefined || userAge === null || userAge === "") return false;
    const age = Number(userAge);
    if (!Number.isFinite(age)) return false;
    return age >= Number(minimumAge);
};

// -----------------------------------------------------------------------------
// Age from date of birth
// HOW: calculateAgeFromDOB() derives full years from a stored DOB against a
//   reference date (defaults to now, injectable for tests). getAgeFromProfile()
//   prefers profile.dateOfBirth — the source of truth — and falls back to the
//   legacy numeric profile.age so documents written before DOB existed still
//   evaluate. Returns a number or null when no usable age exists.
// WHY: The profile form collects DOB via a calendar, never a typed age, so
//   eligibility must compute age dynamically instead of trusting a stored one.
// -----------------------------------------------------------------------------
const calculateAgeFromDOB = (dateOfBirth, now = new Date()) => {
    const dob = dateOfBirth instanceof Date ? dateOfBirth : new Date(dateOfBirth);
    if (Number.isNaN(dob.getTime())) return null;
    const ref = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(ref.getTime()) || dob > ref) return null;
    let age = ref.getFullYear() - dob.getFullYear();
    const hadBirthday =
        ref.getMonth() > dob.getMonth() ||
        (ref.getMonth() === dob.getMonth() && ref.getDate() >= dob.getDate());
    if (!hadBirthday) age -= 1;
    return age;
};

const getAgeFromProfile = (profile, now = new Date()) => {
    const source = profile && typeof profile === "object" ? profile : {};
    if (source.dateOfBirth !== undefined && source.dateOfBirth !== null && source.dateOfBirth !== "") {
        const derived = calculateAgeFromDOB(source.dateOfBirth, now);
        if (derived !== null) return derived;
    }
    if (source.age !== undefined && source.age !== null && source.age !== "") {
        const legacy = Number(source.age);
        if (Number.isFinite(legacy)) return legacy;
    }
    return null;
};

const isEligibleForExam = (exam, profile) => {
    if (!exam || !profile) return false;
    if (!examMatchesEducation(exam.minimumEducationLevel, profile.educationLevel)) return false;
    if (!examMatchesStream(exam.streams, profile.stream)) return false;
    if (!examMatchesPercentage(exam, profile.percentage)) return false;
    if (!examMatchesAge(exam, getAgeFromProfile(profile))) return false;
    if (!userMatchesExamSubjects(profile.subjects, exam)) return false;
    return true;
};

const filterEligibleExams = (exams, profile) => {
    if (!Array.isArray(exams)) return [];
    return exams.filter((exam) => isEligibleForExam(exam, profile));
};

module.exports = {
    CANONICAL_STREAMS,
    normalizeStream,
    isValidStream,
    examMatchesStream,
    normalizeUserSubjects,
    canonicalizeSubject,
    examSchoolSubjects,
    userMatchesExamSubjects,
    isProfileComplete,
    examMatchesEducation,
    examMatchesPercentage,
    examMatchesAge,
    calculateAgeFromDOB,
    getAgeFromProfile,
    isEligibleForExam,
    filterEligibleExams,
};

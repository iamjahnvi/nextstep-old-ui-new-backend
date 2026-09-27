const mongoose = require("mongoose");
// imported mongoose

const {
    CAREER_TYPES,
    EXAM_TYPES,
} = require("../utils/discovery");
// Single source of truth for discovery enums/validators — canonical values
// are defined once in utils/discovery.js, never re-typed here.

// Where a piece of eligibility data came from. SEED = original hand-curated
// dataset, SCRAPER = published from a scraper staging draft, MANUAL = added
// or corrected by a human operator. MIXED = scraper/seed record later touched
// by a manual edit (see manualEdits below). Never inferred — set only by the
// code path that actually wrote the value.
const ELIGIBILITY_SOURCES = ["SEED", "SCRAPER", "MANUAL"];

// Lifecycle of one custom criterion. NEEDS_VERIFICATION = stored but awaiting
// a human check (displayable, never used by recommendation logic).
// NOT_APPLICABLE = explicitly confirmed as not applying (distinct from an
// absent/unknown value — no fake value is stored either way).
const CUSTOM_ELIGIBILITY_STATUSES = ["CONFIRMED", "NEEDS_VERIFICATION", "NOT_APPLICABLE"];

// Controlled extensibility point for criteria outside the common fields.
// Structured (key/label/value + status/source/notes) so entries are
// displayable, auditable, and promotable to first-class fields later —
// never free-form garbage inside core eligibility logic.
const customEligibilitySchema = new mongoose.Schema({
    key : {
        type : String ,
        required : true ,
        trim : true ,
        match : /^[a-z][a-zA-Z0-9]*$/ ,
    } ,
    label : {
        type : String ,
        required : true ,
        trim : true ,
    } ,
    value : {
        type : String ,
        required : true ,
        trim : true ,
    } ,
    status : {
        type : String ,
        enum : CUSTOM_ELIGIBILITY_STATUSES ,
        default : "CONFIRMED" ,
    } ,
    source : {
        type : String ,
        enum : ELIGIBILITY_SOURCES ,
        default : "MANUAL" ,
    } ,
    notes : {
        type : String ,
        default : null ,
        trim : true ,
    } ,
    updatedBy : {
        type : String ,
        default : null ,
        trim : true ,
    } ,
} , { _id : false });

// Audit trail for human corrections. The live value always sits on the exam
// document itself; this array records WHO set it, WHY, and WHEN — so manual
// data stays distinguishable from scraper/seed data forever.
const manualEditSchema = new mongoose.Schema({
    field : {
        type : String ,
        required : true ,
        trim : true ,
    } ,
    source : {
        type : String ,
        enum : ELIGIBILITY_SOURCES ,
        default : "MANUAL" ,
    } ,
    updatedBy : {
        type : String ,
        default : null ,
        trim : true ,
    } ,
    note : {
        type : String ,
        default : null ,
        trim : true ,
    } ,
    updatedAt : {
        type : Date ,
        default : Date.now ,
    } ,
} , { _id : false });

const examSchema = new mongoose.Schema({
    name  : {
        type : String , 
        required : true ,
        trim : true ,
    } ,

    fullForm : {
        type : String , 
        required : true ,
        trim : true ,
    },

    // NULL SEMANTICS (applies to every eligibility field below): null means
    // "no confirmed value" — either not specified by the source or explicitly
    // not applicable. It must NEVER be read as a requirement, a wildcard, or
    // an empty set. Recommendation logic (utils/eligibility.js) skips
    // null/empty criteria instead of filtering on them, and the UI renders
    // null as "No <criterion> specified". UNKNOWN is never converted into a
    // guessed value anywhere in this codebase.
    streams : {
        type : [String] ,
        default : null ,
    } ,

    minimumEducationLevel : {
        type : String ,
        default : null ,
        trim : true ,
    } ,
    // NOTE (Phase 1): values in the dataset mix class levels ("8", "10",
    // "12") and "Graduate". They are stored as canonical strings (see
    // utils/educationLevels.js) and compared by numeric rank in
    // utils/eligibility.js — never with a Mongo string `$lte`.
    // Nullable since the flexible-eligibility redesign: degree-level exams
    // (e.g. GATE-shaped drafts) may carry no school-level bar.

    minimumAge : {
        type : Number ,
        default : null ,
    } ,

    maximumAge : {
        type : Number ,
        default : null ,
    } ,

    registrationStartDate : {
        type : Date,
        required : true 
    } , 
    registrationEndDate : {
        type : Date,
        required : true 
    } ,

    officialWebsite : {
        type : String , 
        required : true , 
        trim : true
    } ,

    description : {
        type : String , 
        trim : true
    },

    eligibility : {
        minimumPercentage : { type : Number , default : null } ,
        // Common structured criteria. Every field is nullable: null = no
        // confirmed value for this exam (not specified or not applicable).
        // Arrays use null (not []) for the same reason.
        degreeRequirements : { type : [String] , default : null } ,
        requiredQualification : { type : String , default : null , trim : true } ,
        qualifyingExam : { type : String , default : null , trim : true } ,
        graduationYear : { type : Number , default : null } ,
        yearOfStudy : { type : String , default : null , trim : true } ,
        attemptsAllowed : { type : Number , default : null } ,
        nationality : { type : String , default : null , trim : true } ,
        domicile : { type : String , default : null , trim : true } ,
        workExperience : { type : String , default : null , trim : true } ,
        professionalRegistration : { type : String , default : null , trim : true } ,
        institutionRequirement : { type : String , default : null , trim : true } ,
        genderEligibility : { type : String , default : null , trim : true } ,
        ageRelaxation : { type : String , default : null , trim : true } ,
        categoryRelaxation : { type : String , default : null , trim : true } ,
        otherEligibility : { type : String , default : null , trim : true } ,
    } ,

    subjects : {
        type : [String] ,
        default : null ,
    } ,

    // Controlled extensible criteria (see customEligibilitySchema above).
    // Displayable even when unused by recommendation logic. Keys must be
    // unique per exam so a frequent criterion can later be promoted to a
    // first-class field without ambiguity.
    customEligibility : {
        type : [customEligibilitySchema] ,
        default : [] ,
        validate : {
            validator : function(entries) {
                if (!Array.isArray(entries)) return false;
                const keys = entries.map((entry) => entry.key);
                return new Set(keys).size === keys.length;
            } ,
            message : "customEligibility keys must be unique within an exam" ,
        } ,
    } ,

    // Provenance of the record itself (see ELIGIBILITY_SOURCES above).
    // Scraper publishes set SCRAPER; the seed dataset is SEED; any manual
    // correction flips the record to MIXED (MANUAL only when the whole
    // record was human-authored). Per-edit detail lives in manualEdits.
    origin : {
        type : String ,
        enum : [...ELIGIBILITY_SOURCES , "MIXED"] ,
        default : "SEED" ,
    } ,

    manualEdits : {
        type : [manualEditSchema] ,
        default : [] ,
    } ,

    redditLinks : [String] ,

    quoraLinks : [String] ,

    // Phase 2 — MainPage discovery data (backend only, no discovery API yet).
    // Stream stays OUT: it belongs to the User profile / Phase 1 eligibility.
    // No month field: month relevance is derived from registrationStartDate /
    // registrationEndDate via examOverlapsMonth() in utils/discovery.js.
    careerType : {
        type : String ,
        enum : CAREER_TYPES ,
        trim : true ,
        uppercase : true ,
    } ,
    // Optional on purpose: legacy documents predate this field, so absence is
    // allowed (treated as unclassified until the data-migration phase). Any
    // value that IS stored must be a valid enum member.

    examType : {
        type : String ,
        enum : EXAM_TYPES ,
        trim : true ,
        uppercase : true ,
    } ,
    // Same backward-compatibility contract as careerType above.

} , {
    timestamps : true,
})

module.exports = mongoose.model("Exam" , examSchema);

module.exports.ELIGIBILITY_SOURCES = ELIGIBILITY_SOURCES;
module.exports.CUSTOM_ELIGIBILITY_STATUSES = CUSTOM_ELIGIBILITY_STATUSES;
const Exam = require("../models/Exam");

const { isProfileComplete, filterEligibleExams } = require("../utils/eligibility");

const {
    applyManualEligibility,
    addCustomEligibility,
    updateCustomEligibility,
    removeCustomEligibility,
} = require("../services/examEligibilityService");

const {
    getApplicationStatus,
    examOverlapsMonth,
    normalizeCareerType,
    normalizeExamType,
    CAREER_TYPES,
    EXAM_TYPES,
    APPLICATION_STATUS,
} = require("../utils/discovery");
// Single source of truth for application status (canonical OPEN_NOW /
// UPCOMING / CLOSED from discovery.js). Mapped here to the existing
// recommendExams response strings the frontend depends on — never rename.

// Canonical -> API response mapping. Response strings are frozen
// for frontend compat ("Open"/"Opening Soon"/"Closed").
const STATUS_RESPONSE_MAP = {
    OPEN_NOW: "Open",
    UPCOMING: "Opening Soon",
    CLOSED: "Closed",
};

// Shared enrichment for recommend + discover: derives status/openingIn/
// closingIn from registration dates via getApplicationStatus(). One
// implementation only — endpoints must not duplicate date logic.
const enrichWithStatus = (exams, now) => {
    return exams.map((exam)=> {

        const{registrationStartDate,registrationEndDate} = exam;
        // Single source of truth: inclusive boundaries live in
        // getApplicationStatus() (start <= now <= end -> OPEN_NOW).
        const canonical = getApplicationStatus(exam, now);
        const status = STATUS_RESPONSE_MAP[canonical];
        let openingIn = null;
        let closingIn = null;
        if(canonical === "OPEN_NOW"){
            closingIn = Math.ceil((registrationEndDate - now)/(1000*60*60*24));

            // if we chose to print closingIn as registrationEndDate-today then it would print something like 1036800000 representing the number of milliseconds elapsed since january 1, 1970 , but instead of this , we'll calculate no. of days which will be :-
            // Math.ceil((registrationEndDate-today)/(1000*60*60*24))

        } else if(canonical === "UPCOMING"){
            openingIn = Math.ceil((registrationStartDate-now)/(1000*24*60*60));
        }

        return{
            ...exam.toObject() ,
            // these three dots mean the spread syntax in javascript , which helps to copies the properties of one object to another brand new object.
            // if we'd hv only written exam , it would hv copied the raw Mongoose document wrapper + your data + internal Mongoose properties but writing exam.toObject() , strips away mongoose baggage , leaving only , a clean js object with your new status fields.
            status ,
            openingIn,
            closingIn
        };
    });
};

// Urgency ordering for result lists: most time-critical first.
//   Open (closing soonest) -> Opening Soon (opening soonest) -> Closed
//   (most recently closed first). Null/missing counters sort last within
//   their group so undated entries never jump above dated ones.
const STATUS_URGENCY_RANK = {
    Open: 0,
    "Opening Soon": 1,
    Closed: 2,
};

const compareByUrgency = (a, b) => {
    const rankA = STATUS_URGENCY_RANK[a.status] ?? 3;
    const rankB = STATUS_URGENCY_RANK[b.status] ?? 3;
    if (rankA !== rankB) return rankA - rankB;
    if (a.status === "Open") {
        const closeA = typeof a.closingIn === "number" ? a.closingIn : Number.MAX_SAFE_INTEGER;
        const closeB = typeof b.closingIn === "number" ? b.closingIn : Number.MAX_SAFE_INTEGER;
        if (closeA !== closeB) return closeA - closeB;
    } else if (a.status === "Opening Soon") {
        const openA = typeof a.openingIn === "number" ? a.openingIn : Number.MAX_SAFE_INTEGER;
        const openB = typeof b.openingIn === "number" ? b.openingIn : Number.MAX_SAFE_INTEGER;
        if (openA !== openB) return openA - openB;
    } else {
        const endA = a.registrationEndDate ? new Date(a.registrationEndDate).getTime() : 0;
        const endB = b.registrationEndDate ? new Date(b.registrationEndDate).getTime() : 0;
        if (endA !== endB) return endB - endA;
    }
    return String(a.name || "").localeCompare(String(b.name || ""));
};

// Month filter helper: matches a calendar month number against the exam's
// own registration window, in whichever year(s) that window spans. All date
// math is delegated to examOverlapsMonth() — no month field is stored.
const examMatchesMonthNumber = (exam, monthIndex) => {
    const years = new Set();
    for (const key of ["registrationStartDate", "registrationEndDate"]) {
        const raw = exam ? exam[key] : null;
        const date = raw ? new Date(raw) : null;
        if (date && !Number.isNaN(date.getTime())) years.add(date.getFullYear());
    }
    if (years.size === 0) return false;
    for (const year of years) {
        if (examOverlapsMonth(exam, year, monthIndex)) return true;
    }
    return false;
};

const recommendExams = async(req , res) => {
    try {
        const user = req.user;

        if(!user){
            return res.status(400).json({
                success : false ,
                message : "user not found"
            });
        }

        const profile = user.profile || {};

        // Profile completeness: educationLevel + stream + percentage are
        // required. Age and subjects are accepted/stored but never required —
        // age-gated exams simply won't match until an age is provided, and
        // the subject check is skipped when the user listed no subjects.
        const { complete, missing } = isProfileComplete(profile);

        if(!complete){
            return res.status(400).json({
                success : false ,
                message : "Profile is incomplete. Please complete your profile first.",
                missing ,
            });
        }

        // Eligibility is evaluated in plain JS via the canonical helpers in
        // utils/eligibility.js (education rank ordering, all-streams stream
        // matching, school-subject overlap, age and percentage gates) instead
        // of unsafe Mongo string comparisons, so every exam variant in the
        // dataset is evaluated consistently.
        const allExams = await Exam.find({});
        const exams = filterEligibleExams(allExams, profile);

        const today = new Date();

        const updatedExams = enrichWithStatus(exams, today).sort(compareByUrgency);

        return res.status(200).json({
            success : true,
            count : exams.length ,
            data : updatedExams ,
        })
        // standard way of returing , data , to frontend

        // object destructuring
        // it is a feature of js that allows us to extract properties from an obj and bind them to variables in a single clean line of code.

        // writing exam.registrationStartDate , exam.registrationEndDate etc is equivalent to saying const{registrationStartDate , registrationEndDate} = exam

    } catch(error) {
        console.log(error);

        return res.status(500).json({
            success : false ,
            message : "Internal server issue"
        });
    }
};

const discoverExams = async(req , res) => {
    try {
        const user = req.user;

        if(!user){
            return res.status(400).json({
                success : false ,
                message : "user not found"
            });
        }

        const profile = user.profile || {};

        // DISCOVERY vs PERSONALIZED ELIGIBILITY (product rule):
        //   - Profile COMPLETE   -> eligibility first, then discovery filters.
        //     Results ARE exams the user is eligible for (personalized: true).
        //   - Profile INCOMPLETE -> discovery filters ONLY, no eligibility.
        //     Results are simply matching exams, never presented as eligible
        //     (personalized: false) — the frontend labels them accordingly.
        const { complete } = isProfileComplete(profile);

        // ---- Validate optional discovery filters (omitted = no filtering).
        // Invalid values are rejected with 400, never silently accepted.
        const query = req.query || {};

        let careerFilter = null;
        if (query.careerType !== undefined && query.careerType !== null && query.careerType !== "") {
            careerFilter = normalizeCareerType(query.careerType);
            if (careerFilter === null) {
                return res.status(400).json({
                    success : false ,
                    message : `Invalid careerType '${query.careerType}'. Must be one of: ${CAREER_TYPES.join(", ")}.`,
                });
            }
        }

        let typeFilter = null;
        if (query.examType !== undefined && query.examType !== null && query.examType !== "") {
            typeFilter = normalizeExamType(query.examType);
            if (typeFilter === null) {
                return res.status(400).json({
                    success : false ,
                    message : `Invalid examType '${query.examType}'. Must be one of: ${EXAM_TYPES.join(", ")}.`,
                });
            }
        }

        let statusFilter = null;
        if (query.applicationStatus !== undefined && query.applicationStatus !== null && query.applicationStatus !== "") {
            const upper = String(query.applicationStatus).trim().toUpperCase();
            if (!APPLICATION_STATUS.includes(upper)) {
                return res.status(400).json({
                    success : false ,
                    message : `Invalid applicationStatus '${query.applicationStatus}'. Must be one of: ${APPLICATION_STATUS.join(", ")}.`,
                });
            }
            statusFilter = upper;
        }

        // Human calendar month 1-12 (e.g. month=5 is May). Converted to the
        // 0-based monthIndex that examOverlapsMonth() expects.
        let monthIndex = null;
        if (query.month !== undefined && query.month !== null && query.month !== "") {
            const parsed = Number(query.month);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
                return res.status(400).json({
                    success : false ,
                    message : `Invalid month '${query.month}'. Must be an integer from 1 (January) to 12 (December).`,
                });
            }
            monthIndex = parsed - 1;
        }

        // Conceptually:
        //   complete profile   -> User profile -> Eligibility -> Discovery filters.
        //   incomplete profile -> All exams -> Discovery filters (no eligibility).
        const allExams = await Exam.find({});
        const exams = complete ? filterEligibleExams(allExams, profile) : allExams;

        const now = new Date();

        const filtered = exams.filter((exam) => {
            if (careerFilter) {
                const value = typeof exam.careerType === "string"
                    ? exam.careerType.trim().toUpperCase()
                    : null;
                if (value !== careerFilter) return false;
            }
            if (typeFilter) {
                const value = typeof exam.examType === "string"
                    ? exam.examType.trim().toUpperCase()
                    : null;
                if (value !== typeFilter) return false;
            }
            if (statusFilter && getApplicationStatus(exam, now) !== statusFilter) return false;
            if (monthIndex !== null && !examMatchesMonthNumber(exam, monthIndex)) return false;
            return true;
        });

        const data = enrichWithStatus(filtered, now).sort(compareByUrgency);

        return res.status(200).json({
            success : true,
            count : data.length ,
            data ,
            // Lets the frontend distinguish "eligible for you" from
            // "matching your filters" without guessing.
            personalized : complete ,
            filters : {
                careerType : careerFilter ,
                examType : typeFilter ,
                month : monthIndex === null ? null : monthIndex + 1 ,
                applicationStatus : statusFilter ,
            } ,
        });

    } catch(error) {
        console.log(error);

        return res.status(500).json({
            success : false ,
            message : "Internal server issue"
        });
    }
};

const getExamById = async (req  , res) => {
    try {

        const {id} = req.params;

        const exam = await Exam.findById(id);

        if(!exam){
            return res.status(404).json({
                success : false ,
                message : "Exam not found"
            })
        }

        return res.status(200).json({
            success : true,
            data : exam
        })

    } catch(error) {
        console.log(error);

        return res.status(500).json({
            success : false ,
            message : "Internal server issue"
        })
    }
}

// Manual eligibility correction (operator path — no admin dashboard exists,
// so this protected endpoint plus examEligibilityService is the smallest
// appropriate layer). Exactly one operation per request: either a common
// field correction ({ field, value }) or a custom-criterion change
// ({ custom: { action: "add"|"update"|"remove", ... } }). Every change is
// stamped MANUAL in manualEdits via the service; scraper publishes only ever
// CREATE new records and can never overwrite these corrections.
const updateExamEligibility = async (req , res) => {
    try {
        const { id } = req.params;
        const { field, value, note, custom } = req.body || {};
        const operator = req.user && (req.user.email || String(req.user._id || "")) || "operator";

        const exam = await Exam.findById(id);
        if (!exam) {
            return res.status(404).json({
                success : false ,
                message : "Exam not found" ,
            });
        }

        if (custom !== undefined && custom !== null) {
            const action = custom.action;
            if (action === "add") {
                addCustomEligibility(exam , {
                    key : custom.key ,
                    label : custom.label ,
                    value : custom.value ,
                    status : custom.status ,
                    notes : custom.notes ,
                    updatedBy : operator ,
                });
            } else if (action === "update") {
                updateCustomEligibility(exam , custom.key , {
                    label : custom.label ,
                    value : custom.value ,
                    status : custom.status ,
                    notes : custom.notes ,
                    updatedBy : operator ,
                });
            } else if (action === "remove") {
                removeCustomEligibility(exam , custom.key , { updatedBy : operator , note });
            } else {
                return res.status(400).json({
                    success : false ,
                    message : "custom.action must be one of: add, update, remove" ,
                });
            }
        } else {
            if (field === undefined || field === null || field === "") {
                return res.status(400).json({
                    success : false ,
                    message : "Provide { field, value } or { custom: { action, ... } }" ,
                });
            }
            applyManualEligibility(exam , { field , value , updatedBy : operator , note });
        }

        await exam.save();

        return res.status(200).json({
            success : true ,
            data : exam ,
        });
    } catch (error) {
        return res.status(400).json({
            success : false ,
            message : error.message ,
        });
    }
};

module.exports = {
    recommendExams ,
    discoverExams ,
    getExamById,
    updateExamEligibility,
};

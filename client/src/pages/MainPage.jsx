import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { EDUCATION_LEVEL_OPTIONS } from "../constants/profileOptions";
import {
    CAREER_TYPE_OPTIONS,
    EXAM_TYPE_OPTIONS,
    MONTH_OPTIONS,
    APPLICATION_STATUS_OPTIONS,
} from "../constants/discoveryOptions";
import { useAuth } from "../context/useAuth";
import FilterSelect from "../components/FilterSelect";
import ProfileMenu from "../components/ProfileMenu";
import ThemeToggle from "../components/ThemeToggle";
import { useTheme } from "../lib/useTheme";
import { avatarInitialFor } from "../lib/avatarInitial";
import "./MainPage.css";

// -----------------------------------------------------------------------------
// MAIN PAGE — NextStep discovery hub (matches design-code/nextstep-main-page).
// BACKEND WIRING:
//   - Profile comes from AuthContext (GET /auth/me at boot).
//   - Discover tab: GET exams/discover with the dropdown filters as query
//     params (sent only when Search is clicked). Eligibility + month/status
//     derivation stay server-side; results arrive urgency-sorted.
//   - My Matches tab: GET exams/recommend (eligible exams, no filters).
//   - Keyword search, quick-filter checkboxes and sort run client-side on top
//     of the fetched results so they feel instant.
//   - Saved exams persist in localStorage (full objects, keyed by _id).
// -----------------------------------------------------------------------------

const EMPTY_FILTERS = {
    careerType: "",
    examType: "",
    month: "",
    applicationStatus: "",
};

const SAVED_KEY = "nextstep:savedExams";

function loadSaved() {
    try {
        const raw = localStorage.getItem(SAVED_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function educationLabel(value) {
    const found = EDUCATION_LEVEL_OPTIONS.find((option) => option.value === value);
    return found ? found.label : value;
}

function careerLabel(value) {
    const found = CAREER_TYPE_OPTIONS.find((option) => option.value === value);
    return found ? found.label : value;
}

function isProfileComplete(profile) {
    if (!profile || typeof profile !== "object") return false;
    const hasEducation =
        profile.educationLevel !== undefined &&
        profile.educationLevel !== null &&
        profile.educationLevel !== "";
    const hasStream =
        profile.stream !== undefined && profile.stream !== null && profile.stream !== "";
    const hasPercentage =
        profile.percentage !== undefined &&
        profile.percentage !== null &&
        profile.percentage !== "";
    return hasEducation && hasStream && hasPercentage;
}

function completeness(profile) {
    if (!profile) return 0;
    const parts = [
        profile.educationLevel,
        profile.stream,
        profile.percentage,
        profile.dateOfBirth,
        profile.gender,
        Array.isArray(profile.subjects) && profile.subjects.length > 0 ? "x" : "",
    ];
    const filled = parts.filter((v) => v !== undefined && v !== null && v !== "").length;
    return Math.round((filled / parts.length) * 100);
}

function shortDate(dateValue) {
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

function examOverlapsMonthIndex(exam, monthIndex) {
    const start = exam.registrationStartDate ? new Date(exam.registrationStartDate) : null;
    const end = exam.registrationEndDate ? new Date(exam.registrationEndDate) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
        return false;
    const years = new Set([start.getFullYear(), end.getFullYear()]);
    for (const year of years) {
        const monthStart = new Date(year, monthIndex, 1, 0, 0, 0, 0);
        const monthEnd = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
        if (start <= monthEnd && end >= monthStart) return true;
    }
    return false;
}

// Career → subtle tinted backdrop for the exam monogram. Monochrome
// typography (exam initials) sits on top — no emojis, one visual language.
const CAREER_TINTS = {
    ENGINEERING: "#eef4ff",
    MEDICAL: "#eafaf1",
    MANAGEMENT: "#f3efff",
    LAW: "#fdf3e7",
    GOVERNMENT_JOBS: "#eef4ff",
    BANKING_INSURANCE: "#e8f1fe",
    DEFENCE: "#fdf3e7",
    TEACHING_EDUCATION: "#f3efff",
    DESIGN_ARCHITECTURE: "#fdeef4",
    SCIENCE_RESEARCH: "#eafaf1",
    ARTS_HUMANITIES: "#fdeef4",
    COMMERCE_FINANCE: "#fdf3e7",
    IT_COMPUTER_APPLICATIONS: "#eef4ff",
    AGRICULTURE: "#eafaf1",
    PARAMEDICAL_NURSING: "#eafaf1",
    HOTEL_MANAGEMENT_HOSPITALITY: "#fdf3e7",
    MASS_COMMUNICATION_JOURNALISM: "#f3efff",
    RAILWAYS: "#eef4ff",
    SSC: "#eef4ff",
    STUDY_ABROAD: "#e8f1fe",
};

function careerTint(careerType) {
    return CAREER_TINTS[careerType] || "#eef4ff";
}

// Exam monogram: first letters of the first two words ("JEE Main" -> "JM").
function examInitials(exam) {
    const words = String(exam?.name || "").trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "?";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
}

function statusMeta(status) {
    if (status === "Open") return { label: "Application Open", cls: "open" };
    if (status === "Opening Soon") return { label: "Upcoming", cls: "upcoming" };
    return { label: "Closed", cls: "closed" };
}

// --- inline SVG icons ---------------------------------------------------------

function IconSearch() {
    return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            <path d="M16.5 16.5 21 21" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
    );
}

function IconBell() {
    return (
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
            />
            <path d="M10 19a2.2 2.2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
    );
}

function IconFunnel() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M4 5h16l-6.5 7.5V19l-3 1.5v-8L4 5Z"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function IconBookmark({ filled }) {
    return (
        <svg width="17" height="17" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} aria-hidden="true">
            <path
                d="M6.5 4.5h11a.5.5 0 0 1 .5.5v14.1a.4.4 0 0 1-.63.33L12 15.7l-5.37 3.73a.4.4 0 0 1-.63-.33V5a.5.5 0 0 1 .5-.5Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function IconCalendar() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="4" y="5.5" width="16" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
    );
}

function IconBulb() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M12 3a6 6 0 0 0-3.5 10.9c.8.6 1.5 1.6 1.5 2.6h4c0-1 .7-2 1.5-2.6A6 6 0 0 0 12 3Z"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinejoin="round"
            />
            <path d="M10 19.5h4M10.8 22h2.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
    );
}

function IconHome() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-5v-5h-4v5H5a1 1 0 0 1-1-1v-8.5Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function IconDoc() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M6.5 3.5h7L19 9v11a1 1 0 0 1-1 1h-11.5a1 1 0 0 1-1-1v-15.5a1 1 0 0 1 1-1Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
            />
            <path d="M13 3.5V9H19M9 13h6M9 16.5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
    );
}

function IconGear() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M4 7h9M17 7h3M4 17h3M11 17h9"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
            />
            <circle cx="15" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="9" cy="17" r="2.2" stroke="currentColor" strokeWidth="1.8" />
        </svg>
    );
}

// --- hero illustration: "Opportunity Journey" (decorative, pure SVG) --------------
// A student at the start of a curved path; exam paper, calendar and stars
// float along it toward a checkmark destination, with a small traveller dot
// looping along the path. All motion is CSS (see .j-* in MainPage.css), plus
// a light cursor parallax driven by --jx/--jy custom properties — no libs.
// Placement lives on outer <g> transform attributes; animation classes sit
// on nested groups so CSS transforms never fight attribute transforms.

const JOURNEY_PATH = "M28,148 C90,140 100,84 160,84 C220,84 216,140 292,118";

function HeroArt() {
    const artRef = useRef(null);

    const handleMove = (e) => {
        const el = artRef.current;
        if (!el) return;
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
        const r = e.currentTarget.getBoundingClientRect();
        el.style.setProperty("--jx", ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
        el.style.setProperty("--jy", ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
    };

    const handleLeave = () => {
        artRef.current?.style.setProperty("--jx", 0);
        artRef.current?.style.setProperty("--jy", 0);
    };

    return (
        <svg
            ref={artRef}
            className="dx-hero-art"
            viewBox="0 0 320 190"
            fill="none"
            aria-hidden="true"
            onMouseMove={handleMove}
            onMouseLeave={handleLeave}
        >
            {/* soft background blobs */}
            <circle cx="258" cy="48" r="42" fill="#fbe3bd" opacity="0.5" />
            <circle cx="64" cy="152" r="26" fill="#fbe3bd" opacity="0.4" />
            <ellipse cx="160" cy="168" rx="120" ry="12" fill="#efe7d3" opacity="0.7" />

            {/* the journey path */}
            <path
                className="j-path"
                d={JOURNEY_PATH}
                stroke="#9aa6bd"
                strokeWidth="2"
                strokeDasharray="5 6"
                strokeLinecap="round"
            />

            {/* stage checkpoints: discover → match → move forward */}
            <g className="j-layer-a">
                <g transform="translate(96,112)">
                    <circle cx="0" cy="0" r="6.5" fill="#fff" stroke="#101f3c" strokeWidth="2" />
                    <circle className="j-node" cx="0" cy="0" r="3" fill="#2f7cf6" />
                </g>
                <g transform="translate(160,84)">
                    <circle cx="0" cy="0" r="6.5" fill="#fff" stroke="#101f3c" strokeWidth="2" />
                    <circle className="j-node j-node--2" cx="0" cy="0" r="3" fill="#f4b942" />
                </g>
                <g transform="translate(228,108)">
                    <circle cx="0" cy="0" r="6.5" fill="#fff" stroke="#101f3c" strokeWidth="2" />
                    <circle className="j-node j-node--3" cx="0" cy="0" r="3" fill="#1d9e57" />
                </g>
            </g>

            {/* far layer (drifts against the cursor) */}
            <g className="j-layer-a">
                <g transform="translate(150,34)">
                    <g className="j-twinkle">
                        <path d="M0 0l2.4 5.4 5.4 2.4-5.4 2.4-2.4 5.4-2.4-5.4-5.4-2.4 5.4-2.4 2.4-5.4Z" fill="#f4b942" />
                    </g>
                </g>
                <g transform="translate(252,66)">
                    <g className="j-twinkle j-twinkle--late">
                        <path d="M0 0l1.8 4 4 1.8-4 1.8-1.8 4-1.8-4-4-1.8 4-1.8 1.8-4Z" fill="#2f7cf6" opacity="0.7" />
                    </g>
                </g>
                {/* exam paper */}
                <g transform="translate(96,52) rotate(-8)">
                    <g className="j-float">
                        <rect x="0" y="0" width="26" height="32" rx="3" fill="#fff" stroke="#101f3c" strokeWidth="2" />
                        <path d="M6 9h14M6 14h14M6 19h9" stroke="#5b6b82" strokeWidth="1.8" strokeLinecap="round" />
                        <circle cx="20" cy="24" r="4.5" fill="#e7f0fd" stroke="#2f7cf6" strokeWidth="1.6" />
                        <path d="M18 24l1.5 1.5L22.5 22" stroke="#2f7cf6" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </g>
                </g>
            </g>

            {/* near layer (drifts with the cursor) */}
            <g className="j-layer-b">
                {/* calendar / deadline */}
                <g transform="translate(188,44)">
                    <g className="j-float-b">
                        <rect x="0" y="0" width="30" height="28" rx="5" fill="#fff" stroke="#101f3c" strokeWidth="2" />
                        <path d="M0 9a5 5 0 0 1 5-5h20a5 5 0 0 1 5 5v1H0V9Z" fill="#2f7cf6" />
                        <path d="M8 0v5M22 0v5" stroke="#101f3c" strokeWidth="2.4" strokeLinecap="round" />
                        <circle cx="9" cy="18" r="1.7" fill="#101f3c" />
                        <circle cx="15" cy="18" r="1.7" fill="#f4b942" />
                        <circle cx="21" cy="18" r="1.7" fill="#101f3c" />
                    </g>
                </g>
                {/* destination checkpoint */}
                <g transform="translate(292,118)">
                    <circle className="j-pulse" cx="0" cy="0" r="12" stroke="#1d9e57" strokeWidth="2" opacity="0.6" />
                    <circle cx="0" cy="0" r="11" fill="#fff" stroke="#101f3c" strokeWidth="2" />
                    <path d="M-4.5 0l3.2 3.2L5-3.5" stroke="#1d9e57" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </g>
            </g>

            {/* student at the start of the path */}
            <g transform="translate(28,148)">
                <g className="j-breathe">
                    <ellipse cx="0" cy="2" rx="12" ry="3" fill="#101f3c" opacity="0.1" />
                    <path d="M-4 -2v-12M4 -2v-12" stroke="#101f3c" strokeWidth="3" strokeLinecap="round" />
                    <rect x="-9" y="-38" width="18" height="26" rx="8" fill="#e7f0fd" stroke="#101f3c" strokeWidth="2.2" />
                    <circle cx="0" cy="-45" r="8.5" fill="#ffd9c4" stroke="#101f3c" strokeWidth="2.2" />
                    <path d="M-8 -47c-1-7 4-11 9-10 4 .6 6 3.5 5.5 8l-2.5.5c.4-3.5-1-5.5-4-6-3-.4-5.5 1.7-5.5 5.5l-2.5 2Z" fill="#101f3c" />
                    <rect x="8" y="-34" width="9" height="14" rx="3" fill="#f4b942" stroke="#101f3c" strokeWidth="1.8" />
                </g>
            </g>

            {/* traveller dot looping along the path */}
            <circle className="j-travel j-travel--trail" cx="0" cy="0" r="2.6" fill="#2f7cf6" opacity="0.45" />
            <circle className="j-travel" cx="0" cy="0" r="4.5" fill="#2f7cf6" stroke="#fff" strokeWidth="2" />
        </svg>
    );
}

// =============================================================================

function MainPage() {
    const navigate = useNavigate();
    const { user, loading: authLoading, logout } = useAuth();

    const [view, setView] = useState("discover"); // discover | matches | saved | tracker | resources | settings
    const [filters, setFilters] = useState(EMPTY_FILTERS); // dropdown drafts
    const [quickCareer, setQuickCareer] = useState([]);
    const [quickExam, setQuickExam] = useState([]);
    const [quickMonths, setQuickMonths] = useState([]);
    const [keyword, setKeyword] = useState("");

    const [discoverCache, setDiscoverCache] = useState([]);
    const [matchesCache, setMatchesCache] = useState([]);
    const [matchesLoaded, setMatchesLoaded] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [needsProfile, setNeedsProfile] = useState(false);
    // Theme is shared across every page that renders the topbar.
    const { theme, toggleTheme } = useTheme();
    // null = not loaded yet; true = results are personalized (eligible for
    // you); false = plain filtered discovery (profile incomplete).
    const [personalized, setPersonalized] = useState(null);
    const [savedMap, setSavedMap] = useState(loadSaved);

    useEffect(() => {
        try {
            localStorage.setItem(SAVED_KEY, JSON.stringify(savedMap));
        } catch {
            /* storage full / private mode — saved marks just won't persist */
        }
    }, [savedMap]);

    const toggleSaved = (exam) => {
        setSavedMap((prev) => {
            const next = { ...prev };
            if (next[exam._id]) delete next[exam._id];
            else next[exam._id] = exam;
            return next;
        });
    };

    // ---- fetching ------------------------------------------------------------
    // DISCOVERY (filters) works with or without a completed profile; the
    // server tells us via `personalized` whether eligibility was applied.
    // RECOMMEND (My Matches) stays gated — it needs a complete profile.
    const runDiscover = useCallback(async (activeFilters) => {
        setLoading(true);
        setError("");
        try {
            const params = {};
            if (activeFilters.careerType) params.careerType = activeFilters.careerType;
            if (activeFilters.examType) params.examType = activeFilters.examType;
            if (activeFilters.month) params.month = activeFilters.month;
            if (activeFilters.applicationStatus)
                params.applicationStatus = activeFilters.applicationStatus;
            const response = await api.get("exams/discover", { params });
            setDiscoverCache(response.data.data || []);
            setPersonalized(response.data.personalized === true);
        } catch (err) {
            setDiscoverCache([]);
            setPersonalized(null);
            setError(err.response?.data?.message || "Failed to load exams. Please try again.");
        } finally {
            setLoading(false);
        }
    }, []);

    const runMatches = useCallback(async () => {
        setLoading(true);
        setError("");
        setNeedsProfile(false);
        try {
            const response = await api.get("exams/recommend");
            setMatchesCache(response.data.data || []);
            setMatchesLoaded(true);
        } catch (err) {
            if (err.response?.data?.missing) {
                setMatchesCache([]);
                setNeedsProfile(true);
                return;
            }
            setMatchesCache([]);
            setError(err.response?.data?.message || "Failed to load exams. Please try again.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!cancelled) await runDiscover(EMPTY_FILTERS);
        })();
        return () => {
            cancelled = true;
        };
    }, [runDiscover]);

    // ---- handlers --------------------------------------------------------------
    const handleFilterChange = (name, value) => {
        setFilters((prev) => ({ ...prev, [name]: value }));
    };

    const handleSearch = () => {
        setView("discover");
        runDiscover(filters);
    };

    const handleClearAll = () => {
        setFilters(EMPTY_FILTERS);
        setQuickCareer([]);
        setQuickExam([]);
        setQuickMonths([]);
        setKeyword("");
        setView("discover");
        runDiscover(EMPTY_FILTERS);
    };

    const toggleIn = (list, setList, value) => {
        setList((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
    };

    const switchView = (next) => {
        setView(next);
        setError("");
        if (next === "matches" && !matchesLoaded) runMatches();
        if (next === "discover" && discoverCache.length === 0 && !loading) runDiscover(filters);
    };

    const handleRetry = () => {
        if (view === "matches") runMatches();
        else runDiscover(filters);
    };

    // ---- derived list ------------------------------------------------------------
    const baseList = useMemo(() => {
        if (view === "matches") return matchesCache;
        if (view === "saved") return Object.values(savedMap);
        return discoverCache;
    }, [view, matchesCache, discoverCache, savedMap]);

    const visibleExams = useMemo(() => {
        const kw = keyword.trim().toLowerCase();
        return baseList.filter((exam) => {
            if (quickCareer.length > 0 && !quickCareer.includes(exam.careerType)) return false;
            if (quickExam.length > 0 && !quickExam.includes(exam.examType)) return false;
            if (quickMonths.length > 0) {
                const hit = quickMonths.some((m) => examOverlapsMonthIndex(exam, Number(m) - 1));
                if (!hit) return false;
            }
            if (kw) {
                const hay = `${exam.name || ""} ${exam.fullForm || ""} ${(exam.subjects || []).join(" ")}`.toLowerCase();
                if (!hay.includes(kw)) return false;
            }
            return true;
        });
    }, [baseList, quickCareer, quickExam, quickMonths, keyword]);

    const trackerGroups = useMemo(() => {
        const groups = { Open: [], "Opening Soon": [], Closed: [] };
        for (const exam of discoverCache) {
            if (groups[exam.status]) groups[exam.status].push(exam);
        }
        return groups;
    }, [discoverCache]);

    const resourceLinks = useMemo(() => {
        const seen = new Map();
        for (const exam of discoverCache) {
            if (exam.officialWebsite && !seen.has(exam.officialWebsite)) {
                seen.set(exam.officialWebsite, exam.name);
            }
        }
        return [...seen.entries()];
    }, [discoverCache]);

    // ---- profile bits --------------------------------------------------------------
    const profile = user?.profile || null;
    const complete = isProfileComplete(profile);
    const pct = completeness(profile);
    const displayName = user?.name ? user.name.split(" ")[0] : "there";
    const avatarInitial = avatarInitialFor(user);
    const streamLine = profile?.stream
        ? `${profile.educationLevel ? educationLabel(profile.educationLevel) : "Student"} • ${profile.stream} Stream`
        : "Complete your profile";
    const pageLoading = authLoading || loading;
    const quickActive = quickCareer.length + quickExam.length + quickMonths.length;

    const renderExamCard = (exam) => {
        const tint = careerTint(exam.careerType);
        const meta = statusMeta(exam.status);
        const isSaved = Boolean(savedMap[exam._id]);
        const chips = [];
        if (exam.minimumEducationLevel !== undefined && exam.minimumEducationLevel !== null) {
            chips.push(`Class ${exam.minimumEducationLevel}`);
        }
        if (Array.isArray(exam.streams) && exam.streams.length > 0) chips.push(exam.streams[0]);
        return (
            <article key={exam._id} className="dx-card">
                <div className="dx-card-icon" style={{ background: tint }} aria-hidden="true">
                    <span className="dx-card-mono">{examInitials(exam)}</span>
                </div>
                <div className="dx-card-main">
                    <h3 className="dx-card-title">{exam.name}</h3>
                    {exam.fullForm && <p className="dx-card-sub">{exam.fullForm}</p>}
                    {chips.length > 0 && (
                        <div className="dx-chips">
                            {chips.map((chip) => (
                                <span key={chip} className="dx-chip">
                                    {chip}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
                <div className="dx-card-side">
                    <div className="dx-side__top">
                        <span className={`dx-pill dx-pill--${meta.cls}`}>{meta.label}</span>
                        <button
                            type="button"
                            className={`dx-iconbtn${isSaved ? " is-saved" : ""}`}
                            onClick={() => toggleSaved(exam)}
                            aria-label={isSaved ? `Remove ${exam.name} from saved` : `Save ${exam.name}`}
                            aria-pressed={isSaved}
                        >
                            <IconBookmark filled={isSaved} />
                        </button>
                    </div>
                    {(exam.registrationStartDate || exam.registrationEndDate) && (
                        <span className="dx-card-date">
                            <IconCalendar />
                            {shortDate(exam.registrationEndDate || exam.registrationStartDate)}
                        </span>
                    )}
                    <button
                        type="button"
                        className="dx-viewbtn"
                        onClick={() => navigate(`/exams/${exam._id}`)}
                        aria-label={`View details of ${exam.name}`}
                    >
                        View details
                        <span className="dx-viewbtn__arrow" aria-hidden="true">→</span>
                    </button>
                </div>
            </article>
        );
    };

    const renderResults = () => {
        if (pageLoading) {
            return (
                <div aria-label="Loading exams">
                    {[0, 1, 2, 3].map((key) => (
                        <div key={key} className="dx-card dx-skeleton-card" aria-hidden="true">
                            <div className="dx-skel dx-skel--icon" />
                            <div className="dx-skel-lines">
                                <div className="dx-skel dx-skel--line" />
                                <div className="dx-skel dx-skel--line short" />
                            </div>
                        </div>
                    ))}
                </div>
            );
        }
        // Only My Matches is gated on profile completion now — Discover
        // always returns (personalized or plain filtered) results.
        if (needsProfile && view === "matches") {
            return (
                <div className="dx-state">
                    <h2>Complete your profile for a personalized outcome.</h2>
                    <p>We need your education, stream and percentage before we can show the exams you qualify for.</p>
                    <button type="button" className="dx-btn-dark" onClick={() => navigate("/profile")}>
                        Complete Profile →
                    </button>
                </div>
            );
        }
        if (error) {
            return (
                <div className="dx-state" role="alert">
                    <h2>Something went wrong.</h2>
                    <p>{error}</p>
                    <button type="button" className="dx-btn-dark" onClick={handleRetry}>
                        Retry
                    </button>
                </div>
            );
        }
        if (view === "saved" && visibleExams.length === 0) {
            return (
                <div className="dx-state">
                    <h2>No saved exams yet.</h2>
                    <p>Tap the bookmark on any exam to pin it here for quick access.</p>
                    <button type="button" className="dx-btn-dark" onClick={() => switchView("discover")}>
                        Browse exams →
                    </button>
                </div>
            );
        }
        if (visibleExams.length === 0) {
            return (
                <div className="dx-state">
                    <h2>No exams match the current filters.</h2>
                    <p>Try widening a filter — or clear them all to see every exam you qualify for.</p>
                    <button type="button" className="dx-btn-dark" onClick={handleClearAll}>
                        Clear all
                    </button>
                </div>
            );
        }
        return (
            <>
                <div className="dx-results-bar">
                    <p>
                        {visibleExams.length} opportunit{visibleExams.length === 1 ? "y" : "ies"} found
                    </p>
                </div>
                <div className="dx-cards">{visibleExams.map(renderExamCard)}</div>
            </>
        );
    };

    return (
        <div className={`dx-page${theme === "dark" ? " dx-page--dark" : ""}`}>
            {/* ---- top bar ---- */}
            <header className="dx-topbar">
                <div className="dx-topbar__inner">
                <button type="button" className="dx-brand" onClick={() => switchView("discover")}>
                    <span className="dx-brand__mark">N</span>
                    NextStep
                </button>
                <nav className="dx-tabs" aria-label="Primary">
                    {[
                        ["discover", "Discover"],
                        ["matches", "My Matches"],
                        ["saved", "Saved"],
                        ["resources", "Resources"],
                    ].map(([key, label]) => (
                        <button
                            key={key}
                            type="button"
                            className={`dx-tab${view === key ? " is-active" : ""}`}
                            onClick={() => switchView(key)}
                        >
                            {label}
                            {key === "saved" && Object.keys(savedMap).length > 0 && (
                                <span className="dx-tab-count">{Object.keys(savedMap).length}</span>
                            )}
                        </button>
                    ))}
                </nav>
                <div className="dx-topsearch" role="search">
                    <input
                        type="search"
                        placeholder="Search exams, olympiads, or keywords…"
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                        aria-label="Search exams by keyword"
                    />
                    <span className="dx-topsearch__icon" aria-hidden="true">
                        <IconSearch />
                    </span>
                </div>
                <div className="dx-topactions">
                <button type="button" className="dx-bell" aria-label="Notifications">
                    <IconBell />
                    <span className="dx-bell__dot" aria-hidden="true" />
                </button>
                <ThemeToggle theme={theme} onToggle={toggleTheme} />
                <ProfileMenu completeness={pct} onSelectView={switchView} />
                </div>
                </div>
            </header>

            <div className="dx-layout">
                {/* ---- left sidebar ---- */}
                <aside className="dx-side" aria-label="Profile and navigation">
                    <div className="dx-profile">
                        <div className="dx-profile__head">
                            {user?.avatar ? (
                                <img className="dx-profile__photo" src={user.avatar} alt={`${user.name}'s profile photo`} />
                            ) : (
                                <span className="dx-profile__photo dx-profile__photo--fallback" aria-hidden="true">
                                    {avatarInitial}
                                </span>
                            )}
                            <div>
                                <p className="dx-profile__name">{user?.name || "Student"}</p>
                                <p className="dx-profile__meta">{streamLine}</p>
                            </div>
                        </div>
                        <div className="dx-ring-row">
                            <span className="dx-ring" role="img" aria-label={`Profile ${pct}% complete`}>
                                <svg width="52" height="52" viewBox="0 0 52 52">
                                    <circle cx="26" cy="26" r="21" fill="none" stroke="#e6ebf2" strokeWidth="6" />
                                    <circle
                                        cx="26"
                                        cy="26"
                                        r="21"
                                        fill="none"
                                        stroke="#2fa37c"
                                        strokeWidth="6"
                                        strokeLinecap="round"
                                        strokeDasharray={`${(pct / 100) * 132} 132`}
                                        transform="rotate(-90 26 26)"
                                    />
                                </svg>
                                <span className="dx-ring__pct">{pct}%</span>
                            </span>
                            <div>
                                <p className="dx-ring__title">Profile Completeness</p>
                                <p className="dx-ring__sub">Complete your profile for better exam recommendations</p>
                            </div>
                        </div>
                        <button type="button" className="dx-btn-dark dx-btn-block dx-btn-arrow" onClick={() => navigate("/profile")}>
                            Complete Profile <span className="dx-btn__arrow" aria-hidden="true">→</span>
                        </button>
                    </div>

                    <nav className="dx-sidenav" aria-label="Section">
                        {[
                            ["discover", "Home", <IconHome key="h" />],
                            ["saved", "Saved Exams", <IconBookmark key="b" filled={false} />],
                            ["tracker", "Application Tracker", <IconDoc key="d" />],
                            ["settings", "Settings", <IconGear key="g" />],
                        ].map(([key, label, icon]) => (
                            <button
                                key={key}
                                type="button"
                                className={`dx-sidenav__item${view === key ? " is-active" : ""}`}
                                onClick={() => switchView(key)}
                            >
                                {icon}
                                {label}
                            </button>
                        ))}
                    </nav>

                    <div className="dx-quote">
                        <p>
                            <svg className="dx-quote__mark" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                <path d="M12 3l2.2 6.1L21 11l-6.8 1.9L12 19l-2.2-6.1L3 11l6.8-1.9L12 3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                            </svg>{" "}
                            Small steps today, big dreams tomorrow.
                        </p>
                        <svg width="46" height="10" viewBox="0 0 46 10" aria-hidden="true">
                            <path d="M1 7c6-6 10 4 16-2s10 4 16-2 8 2 12 0" fill="none" stroke="#f4b942" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                    </div>
                </aside>

                {/* ---- center ---- */}
                <main className="dx-main">
                    {(view === "discover" || view === "matches" || view === "saved") && (
                        <>
                            <section className="dx-hero" aria-label="Welcome">
                                <div className="dx-hero__text">
                                    <p className="dx-hero__eyebrow">Find your next opportunity</p>
                                    <h1>Exams that match your goals</h1>
                                    <p>Discover the right exams, olympiads and government programs based on your profile, interests and eligibility.</p>
                                </div>
                                <HeroArt />
                            </section>

                            {view === "discover" && (
                                <section className="dx-filtercard" aria-label="Filters">
                                    <div className="dx-filtercard__head">
                                        <p>
                                            <IconFunnel /> Find opportunities for you
                                        </p>
                                        <button type="button" className="dx-clear" onClick={handleClearAll}>
                                            Clear all
                                        </button>
                                    </div>
                                    <div className="dx-filterrow">
                                        <FilterSelect
                                            label="Career Type"
                                            value={filters.careerType}
                                            options={[{ value: "", label: "All" }, ...CAREER_TYPE_OPTIONS]}
                                            onChange={(value) => handleFilterChange("careerType", value)}
                                        />
                                        <FilterSelect
                                            label="Exam Type"
                                            value={filters.examType}
                                            options={[{ value: "", label: "All" }, ...EXAM_TYPE_OPTIONS]}
                                            onChange={(value) => handleFilterChange("examType", value)}
                                        />
                                        <FilterSelect
                                            label="Month"
                                            value={filters.month}
                                            options={[{ value: "", label: "All" }, ...MONTH_OPTIONS]}
                                            onChange={(value) => handleFilterChange("month", value)}
                                        />
                                        <FilterSelect
                                            label="Application Status"
                                            value={filters.applicationStatus}
                                            options={[{ value: "", label: "All" }, ...APPLICATION_STATUS_OPTIONS]}
                                            onChange={(value) => handleFilterChange("applicationStatus", value)}
                                            align="right"
                                        />
                                        <button type="button" className="dx-searchbtn" onClick={handleSearch} disabled={loading}>
                                            <span className="dx-searchbtn__label">{loading ? "Searching…" : "Search"}</span>
                                            <span className="dx-searchbtn__icon" aria-hidden="true">
                                                {loading ? (
                                                    <span className="dx-spinner" />
                                                ) : (
                                                    <IconSearch />
                                                )}
                                            </span>
                                        </button>
                                    </div>
                                </section>
                            )}

                            {/* Discovery vs eligibility: the banner states which
                                list the user is looking at, so an incomplete
                                profile is never mistaken for eligibility. */}
                            {view === "discover" && personalized === false && (
                                <section className="dx-notice" aria-label="Browsing all exams">
                                    <p>
                                        <strong>Browsing all exams.</strong> These match
                                        your filters — complete your profile to see
                                        which ones you are eligible for.
                                    </p>
                                    <button
                                        type="button"
                                        className="dx-notice__link"
                                        onClick={() => navigate("/profile")}
                                    >
                                        Complete profile →
                                    </button>
                                </section>
                            )}

                            {view === "discover" && personalized === true && (
                                <section className="dx-notice dx-notice--personal" aria-label="Personalized results">
                                    <p>
                                        <strong>Eligible for you.</strong> Filtered
                                        from the exams your profile qualifies for.
                                    </p>
                                </section>
                            )}

                            {view === "matches" && (
                                <section className="dx-strip" aria-label="About these results">
                                    <p>
                                        <strong>Hello {displayName} —</strong> these are every exam you are eligible for, ordered by urgency. No filters applied.
                                    </p>
                                </section>
                            )}

                            <section aria-label={view === "saved" ? "Saved exams" : "Exam results"}>{renderResults()}</section>
                        </>
                    )}

                    {view === "tracker" && (
                        <section aria-label="Application tracker">
                            <div className="dx-hero dx-hero--slim">
                                <div className="dx-hero__text">
                                    <p className="dx-hero__eyebrow">Stay on schedule</p>
                                    <h1>Application Tracker</h1>
                                    <p>Every exam you qualify for, grouped by where its application window stands right now.</p>
                                </div>
                            </div>
                            {pageLoading ? (
                                <div className="dx-state"><p>Loading your tracker…</p></div>
                            ) : (
                                ["Open", "Opening Soon", "Closed"].map((status) => (
                                    <div key={status} className="dx-trackgroup">
                                        <h2>
                                            {status === "Open" ? "Open now" : status}
                                            <span className="dx-tab-count">{trackerGroups[status]?.length || 0}</span>
                                        </h2>
                                        {(trackerGroups[status] || []).map(renderExamCard)}
                                        {(trackerGroups[status] || []).length === 0 && (
                                            <p className="dx-muted">Nothing here right now.</p>
                                        )}
                                    </div>
                                ))
                            )}
                        </section>
                    )}

                    {view === "resources" && (
                        <section aria-label="Resources">
                            <div className="dx-hero dx-hero--slim">
                                <div className="dx-hero__text">
                                    <p className="dx-hero__eyebrow">Official links</p>
                                    <h1>Resources</h1>
                                    <p>Official websites for the exams you qualify for — always verify dates on the official page.</p>
                                </div>
                            </div>
                            {pageLoading ? (
                                <div className="dx-state"><p>Loading resources…</p></div>
                            ) : resourceLinks.length === 0 ? (
                                <div className="dx-state">
                                    <h2>No resources yet.</h2>
                                    <p>Run a search first — official links appear here.</p>
                                </div>
                            ) : (
                                <div className="dx-resources">
                                    {resourceLinks.map(([url, name]) => (
                                        <div key={url} className="dx-resource">
                                            <div>
                                                <p className="dx-resource__name">{name}</p>
                                                <p className="dx-resource__url">{url.replace(/^https?:\/\//, "").split("/")[0]}</p>
                                            </div>
                                            <a className="dx-resource__link" href={url} target="_blank" rel="noreferrer">
                                                Visit →
                                            </a>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>
                    )}

                    {view === "settings" && (
                        <section aria-label="Settings">
                            <div className="dx-hero dx-hero--slim">
                                <div className="dx-hero__text">
                                    <p className="dx-hero__eyebrow">Your account</p>
                                    <h1>Settings</h1>
                                    <p>Manage your profile and session.</p>
                                </div>
                            </div>
                            <div className="dx-state">
                                <h2>{user?.name || "Student"}</h2>
                                <p>{user?.email || ""}</p>
                                <div className="dx-settings__row">
                                    <button type="button" className="dx-btn-dark" onClick={() => navigate("/profile")}>
                                        Edit Profile →
                                    </button>
                                    <button type="button" className="dx-btn-ghost" onClick={logout}>
                                        Log out
                                    </button>
                                </div>
                            </div>
                        </section>
                    )}
                </main>

                {/* ---- right sidebar ---- */}
                <aside className="dx-quick" aria-label="Quick filters">
                    <h2>
                        <IconFunnel /> Quick Filters
                        {quickActive > 0 && <span className="dx-tab-count">{quickActive}</span>}
                    </h2>

                    <div className="dx-quick__group">
                        <h3>Career Type</h3>
                        {CAREER_TYPE_OPTIONS.map((option) => (
                            <label key={option.value} className="dx-check">
                                <input
                                    type="checkbox"
                                    checked={quickCareer.includes(option.value)}
                                    onChange={() => toggleIn(quickCareer, setQuickCareer, option.value)}
                                />
                                <span className="dx-box" aria-hidden="true">
                                    {quickCareer.includes(option.value) && "✓"}
                                </span>
                                {option.label}
                            </label>
                        ))}
                    </div>

                    <div className="dx-quick__group">
                        <h3>Exam Type</h3>
                        {EXAM_TYPE_OPTIONS.map((option) => (
                            <label key={option.value} className="dx-check">
                                <input
                                    type="checkbox"
                                    checked={quickExam.includes(option.value)}
                                    onChange={() => toggleIn(quickExam, setQuickExam, option.value)}
                                />
                                <span className="dx-box" aria-hidden="true">
                                    {quickExam.includes(option.value) && "✓"}
                                </span>
                                {option.label}
                            </label>
                        ))}
                    </div>

                    <div className="dx-quick__group">
                        <h3>Month</h3>
                        {MONTH_OPTIONS.map((option) => (
                            <label key={option.value} className="dx-check">
                                <input
                                    type="checkbox"
                                    checked={quickMonths.includes(String(option.value))}
                                    onChange={() => toggleIn(quickMonths, setQuickMonths, String(option.value))}
                                />
                                <span className="dx-box" aria-hidden="true">
                                    {quickMonths.includes(String(option.value)) && "✓"}
                                </span>
                                {option.label}
                            </label>
                        ))}
                    </div>

                    <div className="dx-help">
                        <p className="dx-help__title">
                            <IconBulb /> Not sure what to choose?
                        </p>
                        <p>Use your profile to get personalized suggestions and improve your match score.</p>
                        {complete ? (
                            <p className="dx-help__meta">
                                {careerLabel(discoverCache[0]?.careerType) !== discoverCache[0]?.careerType
                                    ? `Top match area: ${careerLabel(discoverCache[0]?.careerType)}`
                                    : "Your matches are ready above."}
                            </p>
                        ) : (
                            <button type="button" className="dx-help__link" onClick={() => navigate("/profile")}>
                                Complete your profile →
                            </button>
                        )}
                    </div>
                </aside>
            </div>
        </div>
    );
}

export default MainPage;

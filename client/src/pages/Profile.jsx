import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../context/useAuth";
import { avatarInitialFor } from "../lib/avatarInitial";
import ProfileMenu from "../components/ProfileMenu";
import ThemeToggle from "../components/ThemeToggle";
import { useTheme } from "../lib/useTheme";
import {
    EDUCATION_LEVEL_OPTIONS,
    STREAM_OPTIONS,
    GENDER_OPTIONS,
    SUBJECT_OPTIONS,
} from "../constants/profileOptions";
import "./Profile.css";

// -----------------------------------------------------------------------------
// PROFILE — "Complete your profile" hub (matches
//   design-code/complete-profile=page.png).
// BACKEND WIRING (unchanged contract):
//   - Initial values are prefilled from AuthContext (GET /auth/me at boot).
//   - Save uses PATCH /auth/profile, then refreshUser() + navigate("/main").
//   - Stream stays single-select (server only accepts the 3 canonical
//     streams), rendered as radio pills like the reference.
//   - Subjects stay an array of strings; the picker is a searchable
//     select-with-chips like the reference.
// -----------------------------------------------------------------------------

function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
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

// ISO date (YYYY-MM-DD) for <input type="date"> value / min / max bounds.
function toDateInputValue(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString().slice(0, 10);
}

function validateDateOfBirthInput(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Please pick a valid date from the calendar.";
    if (date > new Date()) return "Date of birth cannot be in the future.";
    return "";
}

// Downscale a user-picked image to a small thumbnail data URL so the
// PATCH /auth/profile payload stays tiny (no file storage needed).
function fileToThumbnail(file, maxSize = 256) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("read"));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error("decode"));
            img.onload = () => {
                const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL("image/jpeg", 0.85));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

// --- inline SVG icons (stroke style, matches the app) ------------------------

function IconCap() {
    return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 4 2.5 9 12 14l9.5-5L12 4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M6.5 11.5V16c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3v-4.5M21.5 9v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function IconBook() {
    return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15.5H6.7A1.7 1.7 0 0 0 5 20.2V4.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M5 18.5h13.5M9 7.5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
    );
}

function IconPercent() {
    return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M18.5 5.5 5.5 18.5M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
    );
}

function IconCalendar() {
    return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="4" y="5.5" width="16" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
    );
}

function IconLayers() {
    return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m12 3 9 5-9 5-9-5 9-5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="m4.5 12.5 7.5 4 7.5-4M4.5 16.5l7.5 4 7.5-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function IconUser() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="8" r="3.6" stroke="currentColor" strokeWidth="1.8" />
            <path d="M5 20c1.2-3.4 4-5 7-5s5.8 1.6 7 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
    );
}

function IconBookmark({ filled }) {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} aria-hidden="true">
            <path d="M6.5 4.5h11a.5.5 0 0 1 .5.5v14.1a.4.4 0 0 1-.63.33L12 15.7l-5.37 3.73a.4.4 0 0 1-.63-.33V5a.5.5 0 0 1 .5-.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
    );
}

function IconDoc() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6.5 3.5h7L19 9v11a1 1 0 0 1-1 1h-11.5a1 1 0 0 1-1-1v-15.5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
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

function IconEnvelope() {
    return (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3.5" y="5.5" width="17" height="13" rx="2" stroke="currentColor" strokeWidth="1.8" />
            <path d="m4.5 7.5 7.5 6 7.5-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function IconPencil() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m14.5 5.5 4 4L8 19l-5 1 1-5L14.5 5.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
    );
}

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
            <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M10 19a2.2 2.2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
    );
}

function IconChart() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 20V10M10 20V4M16 20v-8M21 20H3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
    );
}

function IconMedal() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="14.5" r="4.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="m9 10.5-2.5-7h4L12 7l1.5-3.5h4L15 10.5M10 14.5l1.2 1.2 2.3-2.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

// =============================================================================

function Profile() {
    const navigate = useNavigate();
    const { user, refreshUser } = useAuth();
    // Shared with the main page topbar: one stored preference everywhere.
    const { theme, toggleTheme } = useTheme();

    const [formData, setFormData] = useState({
        educationLevel: "",
        stream: "",
        percentage: "",
        dateOfBirth: "",
        gender: "",
    });
    const [subjects, setSubjects] = useState([]);
    const [subjectQuery, setSubjectQuery] = useState("");
    const [subjectOpen, setSubjectOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [photoBusy, setPhotoBusy] = useState(false);
    const [photoError, setPhotoError] = useState("");
    const [flashAcademic, setFlashAcademic] = useState(false);
    const photoInputRef = useRef(null);
    const [errors, setErrors] = useState({
        dateOfBirth: "",
        percentage: "",
        _form: "",
    });

    // Prefill once from the shared session (AuthContext boots via /auth/me).
    const prefilledRef = useRef(false);
    useEffect(() => {
        if (user && !prefilledRef.current) {
            prefilledRef.current = true;
            const p = user.profile || {};
            setFormData({
                educationLevel: p.educationLevel ?? "",
                stream: p.stream ?? "",
                percentage: p.percentage ?? "",
                dateOfBirth: toDateInputValue(p.dateOfBirth),
                gender: p.gender ?? "",
            });
            setSubjects(Array.isArray(p.subjects) ? p.subjects : []);
        }
    }, [user]);

    const academicRef = useRef(null);
    const flashTimerRef = useRef(null);
    useEffect(() => {
        return () => {
            if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        };
    }, []);

    // Pencil action: reveal the editing interface — smooth-scroll to the
    // academic form, briefly highlight it, and focus its first field. Values
    // are already pre-filled from the session; saving reuses PATCH
    // /auth/profile via the same submit below.
    const scrollToAcademic = () => {
        academicRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        setFlashAcademic(true);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFlashAcademic(false), 1800);
        setTimeout(() => {
            academicRef.current
                ?.querySelector("input, select")
                ?.focus({ preventScroll: true });
        }, 450);
    };

    const profile = user?.profile || null;
    const pct = completeness(profile);
    const RING_C = 2 * Math.PI * 56;

    const displayName = user?.name || "Student";
    const firstName = displayName.split(" ")[0] || "Student";
    const avatarInitial = avatarInitialFor(user);
    const todayInputValue = useMemo(() => new Date().toISOString().slice(0, 10), []);

    const filteredSubjects = useMemo(() => {
        const q = subjectQuery.trim().toLowerCase();
        const selectedLower = new Set(subjects.map((s) => s.trim().toLowerCase()));
        return SUBJECT_OPTIONS.filter(
            (subject) =>
                !selectedLower.has(subject.toLowerCase()) &&
                (q === "" || subject.toLowerCase().includes(q))
        );
    }, [subjectQuery, subjects]);

    const addSubject = (subject) => {
        // Case-insensitive dedupe: "physics" and "Physics" are the same
        // subject. Store the canonical option casing.
        const canonical =
            SUBJECT_OPTIONS.find((option) => option.toLowerCase() === subject.trim().toLowerCase()) ||
            subject.trim();
        if (!subjects.some((s) => s.trim().toLowerCase() === canonical.toLowerCase())) {
            setSubjects([...subjects, canonical]);
        }
        setSubjectQuery("");
    };

    const removeSubject = (subject) => {
        setSubjects(subjects.filter((item) => item !== subject));
    };

    // Profile photo upload: user picks an image, we downscale it locally and
    // save it as the avatar via the existing PATCH /auth/profile endpoint.
    const handlePhotoFile = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            setPhotoError("Please choose an image file.");
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            setPhotoError("Image must be under 5 MB.");
            return;
        }
        setPhotoBusy(true);
        setPhotoError("");
        try {
            const thumbnail = await fileToThumbnail(file);
            const response = await api.patch("/auth/profile", { avatar: thumbnail });
            if (response.data?.success) {
                await refreshUser();
            }
        } catch {
            setPhotoError("Could not upload photo. Please try again.");
        } finally {
            setPhotoBusy(false);
        }
    };

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData({
            ...formData,
            [name]: value,
        });

        // live-validate percentage (non-negative, <= 100) as the user types.
        if (name === "percentage") {
            let error = "";
            if (value !== "" && Number(value) < 0) {
                error = "Percentage cannot be a negative number.";
            } else if (value !== "" && Number(value) > 100) {
                error = "Percentage cannot be greater than 100.";
            }
            setErrors((prev) => ({ ...prev, percentage: error }));
        }
        if (name === "dateOfBirth") {
            setErrors((prev) => ({ ...prev, dateOfBirth: validateDateOfBirthInput(value) }));
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        const nextErrors = {
            dateOfBirth: validateDateOfBirthInput(formData.dateOfBirth),
            percentage: "",
            _form: "",
        };
        if (formData.percentage !== "") {
            if (Number(formData.percentage) < 0) {
                nextErrors.percentage = "Percentage cannot be a negative number.";
            } else if (Number(formData.percentage) > 100) {
                nextErrors.percentage = "Percentage cannot be greater than 100.";
            }
        }
        // Surface server-side field errors (e.g. gender) inline when present.
        setErrors(nextErrors);
        if (nextErrors.percentage || nextErrors.dateOfBirth) {
            return;
        }

        setSaving(true);
        try {
            const response = await api.patch("/auth/profile", {
                ...formData,
                subjects,
            });

            if (response.data.success) {
                try {
                    await refreshUser();
                } catch {
                    // Intentionally ignored — navigation proceeds regardless.
                }
                navigate("/main");
            }
        } catch (error) {
            const fieldErrors = error.response?.data?.errors || {};
            setErrors((prev) => ({
                ...prev,
                dateOfBirth: fieldErrors.dateOfBirth || "",
                percentage: fieldErrors.percentage || prev.percentage,
                _form:
                    error.response?.data?.message ||
                    fieldErrors.gender ||
                    "Failed to save profile. Please try again.",
            }));
        } finally {
            setSaving(false);
        }
    };

    const goMain = () => navigate("/main");

    return (
        <div className={`pf-page${theme === "dark" ? " pf-page--dark" : ""}`}>
            {/* ---- top bar (same pattern as the main page) ---- */}
            <header className="pf-topbar">
                <div className="pf-topbar__inner">
                <button type="button" className="pf-brand" onClick={goMain}>
                    <span className="pf-brand__mark">N</span>
                    NextStep
                </button>
                <nav className="pf-tabs" aria-label="Primary">
                    {["Discover", "My Matches", "Saved", "Resources"].map((label) => (
                        <button
                            key={label}
                            type="button"
                            className={`pf-tab${label === "Discover" ? " is-active" : ""}`}
                            onClick={goMain}
                        >
                            {label}
                        </button>
                    ))}
                </nav>
                <form
                    className="pf-topsearch"
                    role="search"
                    onSubmit={(e) => {
                        e.preventDefault();
                        goMain();
                    }}
                >
                    <input
                        type="search"
                        placeholder="Search for exams, olympiads, or keywords…"
                        aria-label="Search exams"
                    />
                    <span className="pf-topsearch__icon" aria-hidden="true">
                        <IconSearch />
                    </span>
                </form>
                <div className="pf-topactions">
                <button type="button" className="pf-bell" aria-label="Notifications" onClick={goMain}>
                    <IconBell />
                    <span className="pf-bell__dot" aria-hidden="true" />
                </button>
                <ThemeToggle theme={theme} onToggle={toggleTheme} />
                <ProfileMenu completeness={pct} />
                </div>
                </div>
            </header>

            <div className="pf-wrap">
                {/* ---- profile header card ---- */}
                <section className="pf-hero-card" aria-label="Your profile">
                    <div className="pf-id">
                        <div className="pf-photo-wrap">
                            <div className="pf-photo">
                                <svg width="132" height="132" viewBox="0 0 132 132" aria-hidden="true">
                                    <circle cx="66" cy="66" r="56" fill="none" stroke="#edf0f4" strokeWidth="7" />
                                    <circle
                                        cx="66"
                                        cy="66"
                                        r="56"
                                        fill="none"
                                        stroke="#2f7cf6"
                                        strokeWidth="7"
                                        strokeLinecap="round"
                                        strokeDasharray={`${(pct / 100) * RING_C} ${RING_C}`}
                                        transform="rotate(-90 66 66)"
                                    />
                                </svg>
                                <span className="pf-photo__face" aria-hidden="true">
                                    {user?.avatar ? (
                                        <img src={user.avatar} alt="" />
                                    ) : (
                                        avatarInitial
                                    )}
                                </span>
                                <button
                                    type="button"
                                    className="pf-photo__overlay"
                                    onClick={() => !photoBusy && photoInputRef.current?.click()}
                                    disabled={photoBusy}
                                    aria-label={user?.avatar ? "Change profile photo" : "Add profile photo"}
                                >
                                    <span aria-hidden="true">+</span>
                                    {photoBusy ? "Uploading…" : user?.avatar ? "Change photo" : "Add photo"}
                                </button>
                                <span className="pf-photo__pct">{pct}%</span>
                            </div>
                            <input
                                ref={photoInputRef}
                                type="file"
                                accept="image/*"
                                className="pf-sr"
                                aria-label="Upload profile photo"
                                onChange={handlePhotoFile}
                            />
                            {photoError && (
                                <p className="pf-photo-error" role="alert">
                                    {photoError}
                                </p>
                            )}
                        </div>

                        <div className="pf-id__main">
                            <h1>
                                {firstName}
                                <button
                                    type="button"
                                    className="pf-edit"
                                    onClick={scrollToAcademic}
                                    aria-label="Edit academic details"
                                    title="Edit academic details"
                                >
                                    <IconPencil />
                                </button>
                            </h1>
                            <p className="pf-id__updated">
                                Profile last updated - {formatDate(user?.updatedAt)}
                            </p>
                            <p className="pf-id__email">
                                <IconEnvelope />
                                {user?.email || "—"}
                            </p>
                            <p className="pf-id__email">
                                <IconCalendar />
                                Member since {formatDate(user?.createdAt)}
                            </p>
                            <p className="pf-id__tagline">
                                Dream. Learn. Achieve.
                            </p>
                        </div>
                    </div>

                    <div className="pf-strength" aria-label="Profile strength">
                        <div className="pf-strength__row">
                            <span className="pf-strength__icon" aria-hidden="true">
                                <IconChart />
                            </span>
                            <span>Complete your profile</span>
                            <span className="pf-boost">↑ {pct}%</span>
                        </div>
                        <div className="pf-strength__row">
                            <span className="pf-strength__icon" aria-hidden="true">
                                <IconDoc />
                            </span>
                            <span>Add academic details</span>
                            <span className="pf-boost">↑ 10%</span>
                        </div>
                        <div className="pf-strength__row">
                            <span className="pf-strength__icon" aria-hidden="true">
                                <IconMedal />
                            </span>
                            <span>Add certifications &amp; achievements</span>
                            <span className="pf-boost">↑ 5%</span>
                        </div>
                        <button
                            type="button"
                            className="pf-btn-dark pf-btn-block"
                            onClick={scrollToAcademic}
                        >
                            View profile strength <span aria-hidden="true">→</span>
                        </button>
                    </div>
                </section>

                <div className="pf-layout">
                    {/* ---- left sidebar ---- */}
                    <aside className="pf-side" aria-label="Profile navigation">
                        <nav className="pf-sidenav">
                            {[
                                ["Profile", <IconUser key="u" />, true],
                                ["Saved Exams", <IconBookmark key="b" filled={false} />, false],
                                ["Application Tracker", <IconDoc key="d" />, false],
                                ["Settings", <IconGear key="g" />, false],
                            ].map(([label, icon, active]) => (
                                <button
                                    key={label}
                                    type="button"
                                    className={`pf-sidenav__item${active ? " is-active" : ""}`}
                                    onClick={active ? undefined : goMain}
                                    aria-current={active ? "page" : undefined}
                                >
                                    {icon}
                                    {label}
                                </button>
                            ))}
                        </nav>

                        <div className="pf-quote">
                            <p>Small steps today, big dreams tomorrow.</p>
                            <div
                                className="pf-quote__bar"
                                role="img"
                                aria-label={`Profile ${pct}% complete`}
                            >
                                <span style={{ width: `${pct}%` }} />
                            </div>
                            <p className="pf-quote__pct">{pct}% complete</p>
                        </div>
                    </aside>

                    {/* ---- academic details ---- */}
                    <main className="pf-main">
                        <form
                            ref={academicRef}
                            className={`pf-academic${flashAcademic ? " pf-flash" : ""}`}
                            onSubmit={handleSubmit}
                            autoComplete="off"
                        >
                            <div className="pf-academic__head">
                                <div className="pf-academic__title">
                                    <span className="pf-section-icon pf-section-icon--blue" aria-hidden="true">
                                        <IconCap />
                                    </span>
                                    <div>
                                        <h2>Academic Details</h2>
                                        <p>
                                            Help us understand your academic background so we can
                                            suggest the best exams for you.
                                        </p>
                                    </div>
                                </div>
                                <p className="pf-doodle" aria-hidden="true">
                                    Your goals matter
                                    <svg width="90" height="26" viewBox="0 0 90 26" fill="none">
                                        <path d="M80 4C60 10 30 12 12 8M12 8l6-1M12 8l1 6" stroke="#8a97ab" strokeWidth="1.6" strokeLinecap="round" />
                                        <path d="M4 22c6-5 10 3 16-1s10 3 16-1 8 2 14 0" stroke="#2f7cf6" strokeWidth="1.6" strokeLinecap="round" />
                                    </svg>
                                </p>
                            </div>

                            {errors._form && (
                                <div className="pf-form-error" role="alert">
                                    {errors._form}
                                </div>
                            )}

                            <section className="pf-section pf-section--lilac" aria-label="Date of birth">
                                <span className="pf-section-icon" aria-hidden="true">
                                    <IconCalendar />
                                </span>
                                <div className="pf-section__body">
                                    <h3>Date of Birth</h3>
                                    <p>Pick your date of birth from the calendar — we derive your age from it.</p>
                                    <div className="pf-input-wrap">
                                        <input
                                            type="date"
                                            name="dateOfBirth"
                                            value={formData.dateOfBirth}
                                            min="1900-01-01"
                                            max={todayInputValue}
                                            onChange={handleChange}
                                            autoComplete="off"
                                            aria-describedby="pf-dob-error"
                                        />
                                    </div>
                                    {errors.dateOfBirth && (
                                        <p className="pf-field-error" id="pf-dob-error">
                                            {errors.dateOfBirth}
                                        </p>
                                    )}
                                </div>
                            </section>

                            <section className="pf-section pf-section--lavender" aria-label="Gender">
                                <span className="pf-section-icon" aria-hidden="true">
                                    <IconUser />
                                </span>
                                <div className="pf-section__body">
                                    <h3>Gender</h3>
                                    <p>Select the option that best describes you.</p>
                                    <div className="pf-pills" role="radiogroup" aria-label="Gender">
                                        {GENDER_OPTIONS.map((gender) => (
                                            <button
                                                key={gender}
                                                type="button"
                                                role="radio"
                                                aria-checked={formData.gender === gender}
                                                className={`pf-pill${formData.gender === gender ? " is-selected" : ""}`}
                                                onClick={() =>
                                                    setFormData((prev) => ({ ...prev, gender }))
                                                }
                                            >
                                                {gender}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </section>

                            <section className="pf-section pf-section--mint" aria-label="Percentage">
                                <span className="pf-section-icon" aria-hidden="true">
                                    <IconPercent />
                                </span>
                                <div className="pf-section__body">
                                    <h3>Percentage</h3>
                                    <p>Enter your current percentage (or last available percentage).</p>
                                    <div className="pf-input-wrap">
                                        <input
                                            type="number"
                                            name="percentage"
                                            placeholder="e.g. 95"
                                            min="0"
                                            max="100"
                                            step="any"
                                            value={formData.percentage}
                                            onChange={handleChange}
                                            autoComplete="off"
                                            required
                                            aria-describedby="pf-percentage-error"
                                        />
                                        <span aria-hidden="true">%</span>
                                    </div>
                                    {errors.percentage && (
                                        <p className="pf-field-error" id="pf-percentage-error">
                                            {errors.percentage}
                                        </p>
                                    )}
                                </div>
                            </section>

                            <section className="pf-section pf-section--peach" aria-label="Stream">
                                <span className="pf-section-icon" aria-hidden="true">
                                    <IconBook />
                                </span>
                                <div className="pf-section__body">
                                    <h3>Stream</h3>
                                    <p>Choose your stream.</p>
                                    <div className="pf-pills" role="radiogroup" aria-label="Stream">
                                        {STREAM_OPTIONS.map((stream) => (
                                            <button
                                                key={stream}
                                                type="button"
                                                role="radio"
                                                aria-checked={formData.stream === stream}
                                                className={`pf-pill${formData.stream === stream ? " is-selected" : ""}`}
                                                onClick={() =>
                                                    setFormData((prev) => ({ ...prev, stream }))
                                                }
                                            >
                                                {stream}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </section>

                            <section className="pf-section pf-section--lavender" aria-label="Education level">
                                <span className="pf-section-icon" aria-hidden="true">
                                    <IconCap />
                                </span>
                                <div className="pf-section__body">
                                    <h3>Maximum Education Level</h3>
                                    <p>Select the highest level of education you have completed or are currently pursuing.</p>
                                    <label className="pf-select">
                                        <span className="pf-sr">Education level</span>
                                        <select
                                            name="educationLevel"
                                            value={formData.educationLevel}
                                            onChange={handleChange}
                                            required
                                        >
                                            <option value="">Select education level</option>
                                            {EDUCATION_LEVEL_OPTIONS.map(({ value, label }) => (
                                                <option key={value} value={value}>
                                                    {label}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                </div>
                            </section>

                            <section className="pf-section pf-section--sky" aria-label="Subjects">
                                <span className="pf-section-icon" aria-hidden="true">
                                    <IconLayers />
                                </span>
                                <div className="pf-section__body">
                                    <h3>Subjects</h3>
                                    <p>Select the subjects you are interested in or have studied.</p>
                                    <div className="pf-subjectbox">
                                        <input
                                            type="text"
                                            placeholder="Search and select subjects"
                                            value={subjectQuery}
                                            aria-label="Search and select subjects"
                                            onChange={(e) => {
                                                setSubjectQuery(e.target.value);
                                                setSubjectOpen(true);
                                            }}
                                            onFocus={() => setSubjectOpen(true)}
                                            onBlur={() => {
                                                // Delay so option mousedown fires first.
                                                setTimeout(() => setSubjectOpen(false), 120);
                                            }}
                                        />
                                        <span className="pf-subjectbox__chev" aria-hidden="true">
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                                <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                                            </svg>
                                        </span>
                                        {subjectOpen && (
                                            <ul className="pf-subjectlist" role="listbox" aria-label="Available subjects">
                                                {filteredSubjects.length === 0 ? (
                                                    <li className="pf-subjectlist__empty" aria-hidden="true">
                                                        No matches — try another search.
                                                    </li>
                                                ) : (
                                                    filteredSubjects.map((subject) => (
                                                        <li key={subject} role="option" aria-selected="false">
                                                            <button
                                                                type="button"
                                                                onMouseDown={(e) => e.preventDefault()}
                                                                onClick={() => addSubject(subject)}
                                                            >
                                                                {subject}
                                                            </button>
                                                        </li>
                                                    ))
                                                )}
                                            </ul>
                                        )}
                                    </div>
                                    {subjects.length > 0 && (
                                        <div className="pf-chips">
                                            {subjects.map((subject) => (
                                                <span key={subject} className="pf-chip">
                                                    {subject}
                                                    <button
                                                        type="button"
                                                        onClick={() => removeSubject(subject)}
                                                        aria-label={`Remove ${subject}`}
                                                    >
                                                        ×
                                                    </button>
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </section>

                            <button type="submit" className="pf-btn-dark" disabled={saving}>
                                {saving ? "Saving…" : (
                                    <>
                                        Save changes <span aria-hidden="true">→</span>
                                    </>
                                )}
                            </button>
                        </form>
                    </main>
                </div>
            </div>

            {/* ---- mobile bottom nav (as in the reference) ---- */}
            <nav className="pf-bottomnav" aria-label="Primary mobile">
                <span className="pf-bottomnav__brand">
                    <span className="pf-brand__mark pf-brand__mark--sm">N</span>
                    NextStep
                </span>
                {["Discover", "My Matches", "Saved", "Resources"].map((label, index) => (
                    <button
                        key={label}
                        type="button"
                        className={index === 0 ? "is-active" : ""}
                        onClick={goMain}
                    >
                        {label}
                    </button>
                ))}
                <span className="pf-avatar pf-avatar--sm" aria-hidden="true">
                    {avatarInitial}
                </span>
            </nav>
        </div>
    );
}

export default Profile;

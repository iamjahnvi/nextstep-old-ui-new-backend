import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { avatarInitialFor } from "../lib/avatarInitial";
import "./ProfileMenu.css";

// -----------------------------------------------------------------------------
// ProfileMenu — avatar dropdown in the top bar.
// Pattern inspired by the classic profile-card menu: photo with a completion
// ring, name, a "View & Update Profile" shortcut, then account actions.
// NextStep-aligned: blue ring (never orange), app type scale and borders.
// Only real destinations — no upsells, no placeholder stats.
// Props:
//   completeness — profile completion % for the ring (0-100).
//   onSelectView — optional MainPage view switcher (used for Settings there);
//     when absent, Settings simply returns to the main hub.
// -----------------------------------------------------------------------------

const RING_C = 2 * Math.PI * 32;

const FAQS = [
    {
        q: "How does NextStep match exams to me?",
        a: "Your education level, stream, percentage, subjects and age (derived from your date of birth) are checked against each exam's official eligibility rules.",
    },
    {
        q: "Do I need to complete my profile to browse?",
        a: "No. You can filter and discover exams any time. Personalized eligibility — exams labelled as eligible for you — unlocks once your profile is complete.",
    },
    {
        q: "How is the profile percentage calculated?",
        a: "It tracks the six profile building blocks: education level, stream, percentage, date of birth, gender and subjects.",
    },
    {
        q: "How do I save an exam for later?",
        a: "Tap the bookmark icon on any exam card. Saved exams live under the Saved tab.",
    },
];

function IconGear() {
    return (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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

function IconHelp() {
    return (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
            <path
                d="M9.8 9.5c.3-1.2 1.2-2 2.4-2 1.3 0 2.4 1 2.4 2.2 0 1.7-2.1 2-2.4 3.4M12 16.8v.3"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
            />
        </svg>
    );
}

function IconLogout() {
    return (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M14 4h-8v16h8M10 12h11M18 8.5 21.5 12 18 15.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function ProfileMenu({ completeness = 0, onSelectView }) {
    const navigate = useNavigate();
    const { user, logout } = useAuth();
    const [open, setOpen] = useState(false);
    const [faqOpen, setFaqOpen] = useState(false);
    const rootRef = useRef(null);

    const initial = avatarInitialFor(user);
    const displayName = user?.name?.trim() || "Student";
    const profileLine =
        user?.profile?.stream ||
        (completeness >= 100 ? "Profile complete" : "Complete your profile");

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (e) => {
            if (!rootRef.current?.contains(e.target)) setOpen(false);
        };
        const onKeyDown = (e) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("mousedown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [open ]);

    const goProfile = () => {
        setOpen(false);
        navigate("/profile");
    };

    const goSettings = () => {
        setOpen(false);
        if (onSelectView) onSelectView("settings");
        else navigate("/main");
    };

    return (
        <div ref={rootRef} className="pfm-wrap">
            <button
                type="button"
                className="pfm-avatar"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`Account menu for ${displayName}`}
                onClick={() => setOpen((prev) => !prev)}
            >
                {user?.avatar ? <img src={user.avatar} alt="" /> : initial}
            </button>

            {open && (
                <div className="pfm-panel" role="menu" aria-label="Account">
                    <div className="pfm-head">
                        <div className="pfm-photo">
                            <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true">
                                <circle cx="38" cy="38" r="32" fill="none" stroke="#edf0f4" strokeWidth="5" />
                                <circle
                                    cx="38"
                                    cy="38"
                                    r="32"
                                    fill="none"
                                    stroke="#2f7cf6"
                                    strokeWidth="5"
                                    strokeLinecap="round"
                                    strokeDasharray={`${(completeness / 100) * RING_C} ${RING_C}`}
                                    transform="rotate(-90 38 38)"
                                />
                            </svg>
                            <span className="pfm-photo__face" aria-hidden="true">
                                {user?.avatar ? <img src={user.avatar} alt="" /> : initial}
                            </span>
                            <span className="pfm-photo__pct">{completeness}%</span>
                        </div>
                        <div className="pfm-head__text">
                            <p className="pfm-name">{displayName}</p>
                            <p className="pfm-meta">{profileLine}</p>
                            <button type="button" className="pfm-profile-link" onClick={goProfile}>
                                View &amp; Update Profile
                            </button>
                        </div>
                    </div>

                    <div className="pfm-div" aria-hidden="true" />

                    <button type="button" role="menuitem" className="pfm-row" onClick={goSettings}>
                        <IconGear />
                        Settings
                    </button>
                    <button
                        type="button"
                        role="menuitem"
                        className="pfm-row"
                        onClick={() => {
                            setOpen(false);
                            setFaqOpen(true);
                        }}
                    >
                        <IconHelp />
                        FAQs
                    </button>
                    <button type="button" role="menuitem" className="pfm-row" onClick={logout}>
                        <IconLogout />
                        Logout
                    </button>
                </div>
            )}

            {faqOpen && (
                <div
                    className="pfm-modal-overlay"
                    onMouseDown={(e) => {
                        if (e.target === e.currentTarget) setFaqOpen(false);
                    }}
                >
                    <div className="pfm-modal" role="dialog" aria-modal="true" aria-label="Frequently asked questions">
                        <div className="pfm-modal__head">
                            <h2>FAQs</h2>
                            <button
                                type="button"
                                className="pfm-modal__close"
                                onClick={() => setFaqOpen(false)}
                                aria-label="Close FAQs"
                            >
                                ×
                            </button>
                        </div>
                        {FAQS.map((item) => (
                            <div key={item.q} className="pfm-faq">
                                <p className="pfm-faq__q">{item.q}</p>
                                <p className="pfm-faq__a">{item.a}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

export default ProfileMenu;

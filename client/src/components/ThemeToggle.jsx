import "./ThemeToggle.css";

// Shared dark/light toggle for every topbar. Moon = switch to dark, Sun =
// switch to light: the icon always previews the action, never the state.
function IconMoon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function IconSun() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
            <path
                d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
            />
        </svg>
    );
}

function ThemeToggle({ theme, onToggle }) {
    const dark = theme === "dark";
    return (
        <button
            type="button"
            className="themetoggle"
            onClick={onToggle}
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            title={dark ? "Switch to light mode" : "Switch to dark mode"}
        >
            {dark ? <IconSun /> : <IconMoon />}
        </button>
    );
}

export default ThemeToggle;

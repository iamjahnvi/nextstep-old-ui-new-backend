import { useState, useCallback } from "react";

const STORAGE_KEY = "nextstep:theme";

// Shared theme state: stored preference wins, otherwise the OS setting,
// otherwise light. One hook drives every page that renders the topbar, so
// the toggle stays in sync everywhere.
export function useTheme() {
    const [theme, setTheme] = useState(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored === "dark" || stored === "light") return stored;
        } catch {
            /* private mode — fall through to OS preference */
        }
        return typeof window !== "undefined" &&
            window.matchMedia?.("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
    });

    const toggleTheme = useCallback(() => {
        setTheme((prev) => {
            const next = prev === "dark" ? "light" : "dark";
            try {
                localStorage.setItem(STORAGE_KEY, next);
            } catch {
                /* private mode — theme just won't persist */
            }
            return next;
        });
    }, []);

    return { theme, toggleTheme };
}

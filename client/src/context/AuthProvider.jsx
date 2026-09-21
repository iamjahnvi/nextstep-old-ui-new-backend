import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import api, { setOnUnauthorized } from "../services/api";
import { AuthContext } from "./AuthContext";

// -----------------------------------------------------------------------------
// AUTH PROVIDER — single source of truth for client authentication state.
// HOW: JWT lives in localStorage (existing convention); the request
//   interceptor in services/api.js attaches it. On boot, a stored token is
//   validated/restored via the existing GET /auth/me. A central 401 handler
//   (registered here) clears the session; the interceptor owns the redirect.
// WHY: pages previously each managed tokens, /auth/me calls and 401 branches
//   independently. Centralizing removes that duplication without touching the
//   backend contract.
// -----------------------------------------------------------------------------

export function AuthProvider({ children }) {
    const navigate = useNavigate();
    const [user, setUser] = useState(null);
    const [token, setToken] = useState(() => localStorage.getItem("token"));
    // loading = session still being restored; ProtectedRoute waits on this
    // so protected content never flashes before redirect (edge case H).
    const [loading, setLoading] = useState(true);

    const isAuthenticated = !!token && !!user;

    const refreshUser = useCallback(async () => {
        const response = await api.get("/auth/me");
        const nextUser = response.data.user || null;
        setUser(nextUser);
        return nextUser;
    }, []);

    const clearSession = useCallback(() => {
        localStorage.removeItem("token");
        setToken(null);
        setUser(null);
    }, []);

    // login: store JWT, then hydrate the full user (login/signup responses
    // carry only id/name/email — never the profile). Throws on failure so
    // callers can show inline errors instead of navigating.
    const login = useCallback(
        async (newToken) => {
            localStorage.setItem("token", newToken);
            setToken(newToken);
            try {
                return await refreshUser();
            } catch (error) {
                clearSession();
                throw error;
            }
        },
        [refreshUser, clearSession]
    );

    const logout = useCallback(() => {
        clearSession();
        navigate("/login");
    }, [clearSession, navigate]);

    // Central 401 clearing: the api interceptor redirects; this only drops
    // the local session state. Idempotent by design (boot + interceptor may
    // both observe the same expiry).
    useEffect(() => {
        setOnUnauthorized(clearSession);
        return () => setOnUnauthorized(null);
    }, [clearSession]);

    // Boot: restore session from the stored JWT (edge cases E/F), drop
    // invalid tokens cleanly (edge case C — the interceptor redirects when
    // we are off the auth pages).
    useEffect(() => {
        let cancelled = false;
        const boot = async () => {
            const stored = localStorage.getItem("token");
            if (!stored) {
                if (!cancelled) setLoading(false);
                return;
            }
            setToken(stored);
            try {
                await refreshUser();
            } catch {
                if (!cancelled) clearSession();
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        boot();
        return () => {
            cancelled = true;
        };
    }, [refreshUser, clearSession]);

    const value = useMemo(
        () => ({ user, token, loading, isAuthenticated, login, logout, refreshUser }),
        [user, token, loading, isAuthenticated, login, logout, refreshUser]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

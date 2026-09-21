import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../context/useAuth";
import "./GoogleAuthButton.css";

// -----------------------------------------------------------------------------
// GOOGLE OAUTH — "Continue with Google" (shared button)
// HOW: 1) The OAuth client ID is fetched from our own backend
//         (GET /auth/google/config) so it lives ONLY in server .env.
//      2) Google's Identity Services script is loaded once (module-level
//         promise, so remounts / navigating Login <-> Signup reuse it).
//      3) GIS is (re-)initialised on every mount with a fresh callback, then
//         the OFFICIAL Google button is rendered invisibly OVER our custom
//         styled button. Clicks land on Google's iframe, so the account
//         chooser ALWAYS opens — unlike prompt(), which browsers increasingly
//         suppress (FedCM / One Tap opt-outs).
//      4) Google returns a signed ID token (credential) -> we POST it to OUR
//         backend POST /auth/google, where it is cryptographically VERIFIED,
//         the user is registered/logged-in, and our own JWT is returned.
// WHY:  Backend verification (never trusting the browser) is the secure OAuth
//   pattern; the invisible-overlay trick keeps the page's custom design while
//   using Google's supported, reliable click path.
// -----------------------------------------------------------------------------

const GOOGLE_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

// Singleton: one script tag + one promise for the whole SPA lifetime.
let googleScriptPromise = null;

function loadGoogleScript() {
    if (typeof window !== "undefined" && window.google?.accounts?.id) {
        return Promise.resolve();
    }
    if (googleScriptPromise) return googleScriptPromise;
    googleScriptPromise = new Promise((resolve, reject) => {
        const existing = document.getElementById("gsi-client-script");
        if (existing) {
            // Tag from an earlier mount: just wait for it (or resolve now).
            if (typeof window !== "undefined" && window.google?.accounts?.id) {
                resolve();
            } else {
                existing.addEventListener("load", () => resolve(), { once: true });
                existing.addEventListener("error", () => reject(new Error("Google script failed to load.")), { once: true });
            }
            return;
        }
        const script = document.createElement("script");
        script.id = "gsi-client-script";
        script.src = GOOGLE_SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Google script failed to load."));
        document.body.appendChild(script);
    });
    return googleScriptPromise;
}

function GoogleIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path
                fill="#4285F4"
                d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"
            />
            <path
                fill="#34A853"
                d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.98v2.33A9 9 0 0 0 9 18z"
            />
            <path
                fill="#FBBC05"
                d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.98A9 9 0 0 0 0 9c0 1.45.35 2.83.98 4.03l2.97-2.33z"
            />
            <path
                fill="#EA4335"
                d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .98 4.97l2.97 2.33C4.66 5.17 6.65 3.58 9 3.58z"
            />
        </svg>
    );
}

function GoogleAuthButton({
    label = "Continue with Google",
    buttonClassName = "",
    onError,
}) {
    const navigate = useNavigate();
    const { login } = useAuth();
    const [busy, setBusy] = useState(false);
    const [ready, setReady] = useState(false);
    const overlayRef = useRef(null);
    const wrapRef = useRef(null);
    // Refs avoid the stale-closure bug: GIS keeps the callback given at
    // initialize() time, so it must always call the LATEST login/navigate.
    // Assigned in an effect (not during render) per react-hooks/refs.
    const callbackRef = useRef(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        callbackRef.current = async (response) => {
            if (!response?.credential) {
                onError?.("Google sign-in was cancelled. Please try again.");
                return;
            }
            setBusy(true);
            onError?.("");
            try {
                const res = await api.post("/auth/google", {
                    credential: response.credential,
                });
                if (res.data?.success && res.data?.token) {
                    await login(res.data.token);
                    navigate("/main");
                } else {
                    onError?.("Google sign-in failed. Please try again.");
                }
            } catch (error) {
                onError?.(
                    error.response?.data?.message ||
                        "Google sign-in failed. Please try again."
                );
            } finally {
                if (mountedRef.current) setBusy(false);
            }
        };
    });

    useEffect(() => {
        mountedRef.current = true;
        let cancelled = false;
        const overlayNode = overlayRef.current;
        const wrapNode = wrapRef.current;

        const setup = async () => {
            try {
                const configRes = await api.get("/auth/google/config");
                const clientId = configRes.data?.clientId;
                if (cancelled || !mountedRef.current) return;
                if (!clientId) {
                    onError?.(
                        "Google sign-in is not configured yet (GOOGLE_CLIENT_ID missing on the server)."
                    );
                    return;
                }
                await loadGoogleScript();
                if (cancelled || !mountedRef.current) return;
                if (!window.google?.accounts?.id) {
                    onError?.("Could not set up Google sign-in. Please try again.");
                    return;
                }
                // Re-initialise on every mount with the fresh callback ref.
                window.google.accounts.id.initialize({
                    client_id: clientId,
                    callback: (...args) => callbackRef.current?.(...args),
                    auto_select: false,
                    use_fedcm_for_prompt: true,
                });
                // Render Google's official button invisibly over our custom
                // one. GIS has no unmount API; clearing the host div on
                // cleanup prevents duplicate iframes across remounts.
                if (overlayNode) {
                    overlayNode.innerHTML = "";
                    const width = Math.min(
                        400,
                        Math.max(200, wrapNode?.clientWidth || 300)
                    );
                    window.google.accounts.id.renderButton(overlayNode, {
                        type: "standard",
                        theme: "outline",
                        size: "large",
                        text: "continue_with",
                        shape: "rectangular",
                        width,
                    });
                }
                if (!cancelled && mountedRef.current) setReady(true);
            } catch {
                if (!cancelled && mountedRef.current) {
                    onError?.("Could not set up Google sign-in. Please try again.");
                }
            }
        };

        setup();

        return () => {
            cancelled = true;
            mountedRef.current = false;
            if (overlayNode) overlayNode.innerHTML = "";
        };
        // onError/login/navigate are stable enough; re-running setup on every
        // parent render would re-render the GIS iframe needlessly.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleFallbackClick = () => {
        // Fires only when the overlay isn't ready yet (script still loading
        // or config missing) — once ready, clicks land on Google's iframe.
        if (ready && !busy) return;
        if (busy) return;
        onError?.(
            ready
                ? "Google sign-in is loading — please try again in a moment."
                : "Setting up Google sign-in — please try again in a moment."
        );
    };

    return (
        <div ref={wrapRef} className="google-auth-wrap">
            <button
                type="button"
                className={buttonClassName}
                onClick={handleFallbackClick}
                disabled={busy}
            >
                <GoogleIcon />
                {busy ? "Signing in…" : label}
            </button>
            {/* Invisible official Google button: the reliable click target. */}
            <div
                ref={overlayRef}
                className="google-auth-overlay"
                hidden={!ready || busy}
                aria-hidden="true"
            />
        </div>
    );
}

export default GoogleAuthButton;

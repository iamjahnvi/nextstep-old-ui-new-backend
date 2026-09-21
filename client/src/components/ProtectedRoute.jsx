import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/useAuth";

// -----------------------------------------------------------------------------
// PROTECTED ROUTE — gates authenticated pages on the shared auth state.
// HOW: while the session is being restored (loading) render a neutral
//   placeholder so protected content never flashes (edge case H); otherwise
//   redirect unauthenticated visits to /login (edge cases A, C, F).
// -----------------------------------------------------------------------------
function ProtectedRoute({ children }) {
    const { loading, isAuthenticated } = useAuth();
    const location = useLocation();

    if (loading) {
        return (
            <div
                style={{
                    minHeight: "100svh",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "'Space Grotesk', sans-serif",
                    color: "#55617d",
                }}
            >
                Loading…
            </div>
        );
    }

    if (!isAuthenticated) {
        return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    }

    return children;
}

export default ProtectedRoute;

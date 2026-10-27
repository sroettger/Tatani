import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";

export function ProtectedRoute({ children }: { children: JSX.Element }) {
  const location = useLocation();
  const { user, loading, progress } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center bg-background">
        <div className="text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (!user) {
    if (location.pathname.startsWith("/notifications/review/")) sessionStorage.setItem("tatani-review-return", location.pathname);
    return <Navigate to="/auth" replace />;
  }
  // Placement is tracked per learning language.
  if (progress && !progress.placement_done) return <Navigate to="/onboarding" replace />;
  return children;
}

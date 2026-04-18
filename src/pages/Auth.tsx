import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/context/AuthContext";
import { lovable } from "@/integrations/lovable";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";

export default function Auth() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) navigate("/", { replace: true });
  }, [user, loading, navigate]);

  const signIn = async () => {
    setBusy(true);
    try {
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });
      if ((result as any)?.error) {
        toast.error("Sign-in failed", { description: String((result as any).error?.message ?? "Unknown error") });
      }
    } catch (e) {
      toast.error("Sign-in failed", { description: e instanceof Error ? e.message : "Unknown error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen gradient-hero grid place-items-center px-5">
      <Card className="w-full max-w-sm p-8 gradient-card border-border/50 shadow-card">
        <div className="flex items-center justify-center mb-6">
          <div className="h-14 w-14 rounded-2xl gradient-primary grid place-items-center shadow-elegant">
            <Sparkles className="h-7 w-7 text-primary-foreground" />
          </div>
        </div>
        <h1 className="text-2xl font-bold text-center mb-2">Anime Japanese Trainer</h1>
        <p className="text-sm text-muted-foreground text-center mb-8">
          Learn Japanese from the anime you actually want to watch. Personalized flashcards, adaptive to your level.
        </p>
        <Button onClick={signIn} disabled={busy} className="w-full h-12 gradient-primary text-primary-foreground hover:opacity-90 transition-opacity">
          <svg className="h-5 w-5" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/>
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.1-11.3-7.5l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.2 5.6l6.2 5.2C40 35.5 44 30.3 44 24c0-1.3-.1-2.3-.4-3.5z"/>
          </svg>
          {busy ? "Opening Google…" : "Continue with Google"}
        </Button>
        <p className="text-xs text-muted-foreground text-center mt-6">
          We use your Google account just to sign you in. No spam, ever.
        </p>
      </Card>
    </main>
  );
}

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/context/AuthContext";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Sparkles, Eye, EyeOff, Mail } from "lucide-react";
import { useI18n } from "@/i18n";

function appBaseUrl(): string {
  return new URL(import.meta.env.BASE_URL || "/", window.location.origin).toString();
}

export default function Auth() {
  const { user, loading } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [confirmSent, setConfirmSent] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      const returnTo = sessionStorage.getItem("tatani-review-return");
      sessionStorage.removeItem("tatani-review-return");
      navigate(returnTo?.startsWith("/notifications/review/") ? returnTo : "/", { replace: true });
    }
  }, [user, loading, navigate]);

  const signInGoogle = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: appBaseUrl(),
        },
      });
      if (error) {
        toast.error(t("auth.signInFailed"), { description: error.message || t("auth.unknownError") });
      }
    } catch (e) {
      toast.error(t("auth.signInFailed"), { description: e instanceof Error ? e.message : t("auth.unknownError") });
    } finally {
      setBusy(false);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: appBaseUrl() },
        });
        if (error) throw error;
        setConfirmSent(true);
        toast.success(t("auth.checkEmail"), { description: t("auth.checkEmailBody") });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (e: unknown) {
      toast.error(isSignUp ? t("auth.signUpFailed") : t("auth.signInFailed"), {
        description: e instanceof Error ? e.message : t("auth.unknownError"),
      });
    } finally {
      setBusy(false);
    }
  };

  const forgotPassword = async () => {
    if (!email) {
      toast.error(t("auth.enterEmailFirst"));
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: new URL("reset-password", appBaseUrl()).toString(),
    });
    setBusy(false);
    if (error) {
      toast.error(t("auth.resetFailedTitle"), { description: error.message });
    } else {
      toast.success(t("auth.resetSentTitle"), { description: t("auth.resetSentBody") });
    }
  };

  if (confirmSent) {
    return (
      <main className="min-h-screen gradient-hero grid place-items-center px-5">
        <Card className="w-full max-w-sm p-8 gradient-card border-border/50 shadow-card text-center">
          <div className="flex items-center justify-center mb-6">
            <div className="h-14 w-14 rounded-2xl gradient-primary grid place-items-center shadow-elegant">
              <Mail className="h-7 w-7 text-primary-foreground" />
            </div>
          </div>
          <h1 className="text-2xl font-bold mb-2">{t("auth.checkEmail")}</h1>
          <p className="text-sm text-muted-foreground mb-6">
            {t("auth.confirmEmailBody", { email })}
          </p>
          <Button variant="ghost" onClick={() => setConfirmSent(false)} className="w-full">
            {t("auth.backToSignIn")}
          </Button>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-screen gradient-hero grid place-items-center px-5 py-8">
      <Card className="w-full max-w-sm p-8 gradient-card border-border/50 shadow-card">
        <div className="flex items-center justify-center mb-6">
          <div className="h-14 w-14 rounded-2xl gradient-primary grid place-items-center shadow-elegant">
            <Sparkles className="h-7 w-7 text-primary-foreground" />
          </div>
        </div>
        <h1 className="text-2xl font-bold text-center mb-2">{t("auth.appName")}</h1>
        <p className="text-sm text-muted-foreground text-center mb-8">
          {t("auth.tagline")}
        </p>

        {!isSupabaseConfigured && (
          <div className="mb-5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
            Backend not configured yet: set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> in your environment or GitHub Actions variables.
          </div>
        )}

        <form onSubmit={handleEmailSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t("auth.email")}</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("auth.emailPlaceholder")}
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t("auth.password")}</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={6}
                autoComplete={isSignUp ? "new-password" : "current-password"}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                aria-label={t("auth.togglePw")}
              >
                {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {!isSignUp && (
            <button type="button" onClick={forgotPassword} className="text-xs text-primary hover:underline w-full text-right">
              {t("auth.forgotPassword")}
            </button>
          )}

          <Button type="submit" disabled={busy} className="w-full h-11 gradient-primary text-primary-foreground hover:opacity-90 transition-opacity">
            {busy ? (isSignUp ? t("auth.creatingAccount") : t("auth.signingIn")) : (isSignUp ? t("auth.createAccount") : t("auth.signIn"))}
          </Button>
        </form>

        <p className="text-sm text-center mt-4">
          {isSignUp ? t("auth.alreadyHaveAccount") : t("auth.noAccount")}{" "}
          <button type="button" onClick={() => setIsSignUp((s) => !s)} className="text-primary hover:underline font-medium">
            {isSignUp ? t("auth.signIn") : t("auth.createAccount")}
          </button>
        </p>

        <div className="flex items-center gap-3 my-6">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">{t("auth.or")}</span>
          <Separator className="flex-1" />
        </div>

        <Button onClick={signInGoogle} disabled={busy} variant="outline" className="w-full h-11 gap-2 border-border/60 bg-background/50 hover:bg-background">
          <svg className="h-5 w-5" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/>
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.1-11.3-7.5l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.2 5.6l6.2 5.2C40 35.5 44 30.3 44 24c0-1.3-.1-2.3-.4-3.5z"/>
          </svg>
          {t("auth.continueGoogle")}
        </Button>
      </Card>
    </main>
  );
}

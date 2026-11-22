import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Sparkles, Eye, EyeOff } from "lucide-react";

function hasUrlRecoveryMarker(searchParams: URLSearchParams): boolean {
  if (searchParams.get("type") === "recovery") return true;
  if (searchParams.has("code") || searchParams.has("token_hash")) return true;
  if (typeof window !== "undefined") {
    const hash = window.location.hash;
    if (hash.includes("type=recovery") || hash.includes("access_token=")) {
      return true;
    }
  }
  return false;
}

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [checking, setChecking] = useState(() => !hasUrlRecoveryMarker(searchParams));

  useEffect(() => {
    let active = true;
    let recovered = hasUrlRecoveryMarker(searchParams);

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session)) {
        recovered = true;
        setChecking(false);
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!active) return;
      if (session || recovered) {
        setChecking(false);
      } else {
        toast.error("Invalid reset link");
        navigate("/auth", { replace: true });
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [searchParams, navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    if (password !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      toast.error("Failed to reset password", { description: error.message });
    } else {
      toast.success("Password updated successfully");
      navigate("/auth", { replace: true });
    }
  };

  if (checking) {
    return (
      <main className="min-h-screen gradient-hero grid place-items-center px-5">
        <div className="text-sm text-muted-foreground">Verifying reset link…</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen gradient-hero grid place-items-center px-5">
      <Card className="w-full max-w-sm p-8 gradient-card border-border/50 shadow-card">
        <div className="flex items-center justify-center mb-6">
          <div className="h-14 w-14 rounded-2xl gradient-primary grid place-items-center shadow-elegant">
            <Sparkles className="h-7 w-7 text-primary-foreground" />
          </div>
        </div>
        <h1 className="text-2xl font-bold text-center mb-2">Set new password</h1>
        <p className="text-sm text-muted-foreground text-center mb-8">Enter your new password below.</p>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pw">New password</Label>
            <div className="relative">
              <Input
                id="pw"
                type={show ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={6}
                className="pr-10"
              />
              <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm password</Label>
            <Input
              id="confirm"
              type={show ? "text" : "password"}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
            />
          </div>
          <Button type="submit" disabled={busy} className="w-full h-11 gradient-primary text-primary-foreground hover:opacity-90 transition-opacity">
            {busy ? "Updating…" : "Update password"}
          </Button>
        </form>
      </Card>
    </main>
  );
}

import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Sparkles, Eye, EyeOff } from "lucide-react";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  const type = searchParams.get("type");

  useEffect(() => {
    if (type !== "recovery") {
      toast.error("Invalid reset link");
      navigate("/auth", { replace: true });
    }
  }, [type, navigate]);

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

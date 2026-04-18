import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { useAuth } from "@/context/AuthContext";
import { Settings as SettingsIcon, LogOut, RotateCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export default function Settings() {
  const { profile, signOut, refreshProfile, user } = useAuth();
  const navigate = useNavigate();

  const retakePlacement = async () => {
    if (!user) return;
    await supabase.from("profiles").update({ placement_done: false, jlpt_level: "none" }).eq("user_id", user.id);
    await refreshProfile();
    toast.success("Let's redo your placement");
    navigate("/onboarding");
  };

  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader title="Settings" subtitle="Account" icon={<SettingsIcon className="h-4 w-4" />} />
      <div className="px-5 grid gap-3">
        <Card className="p-4 gradient-card border-border/50">
          <div className="flex items-center gap-3">
            {profile?.avatar_url && <img src={profile.avatar_url} alt="" className="h-12 w-12 rounded-full" />}
            <div>
              <div className="font-semibold">{profile?.display_name ?? "User"}</div>
              <div className="text-xs text-muted-foreground">JLPT {profile?.jlpt_level === "none" ? "—" : profile?.jlpt_level}</div>
            </div>
          </div>
        </Card>

        <Card className="p-4 gradient-card border-border/50">
          <h3 className="font-semibold mb-1">Retake placement quiz</h3>
          <p className="text-xs text-muted-foreground mb-3">Generates a fresh quiz and re-seeds your known-word list.</p>
          <Button variant="outline" onClick={retakePlacement}><RotateCw className="h-4 w-4" /> Retake</Button>
        </Card>

        <Card className="p-4 gradient-card border-border/50">
          <h3 className="font-semibold mb-1">Sign out</h3>
          <p className="text-xs text-muted-foreground mb-3">You'll need to sign back in with Google.</p>
          <Button variant="destructive" onClick={async () => { await signOut(); navigate("/auth"); }}>
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </Card>
      </div>
    </div>
  );
}

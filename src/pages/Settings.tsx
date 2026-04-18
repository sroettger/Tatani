import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { useAuth } from "@/context/AuthContext";
import { Settings as SettingsIcon, LogOut, RotateCw, Trash2 } from "lucide-react";
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

  const resetStudyData = async () => {
    if (!user) return;
    if (!confirm("Reset all study data? This wipes known words, quiz results, and study sessions, and resets your placement.")) return;
    try {
      await Promise.all([
        supabase.from("user_word_state").delete().eq("user_id", user.id),
        supabase.from("quiz_results").delete().eq("user_id", user.id),
        supabase.from("study_sessions").delete().eq("user_id", user.id),
      ]);
      await supabase
        .from("profiles")
        .update({ placement_done: false, jlpt_level: "none", total_words_known: 0, study_streak: 0 })
        .eq("user_id", user.id);
      await refreshProfile();
      toast.success("Study data reset");
      navigate("/onboarding");
    } catch (e) {
      toast.error("Failed to reset study data");
    }
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
          <h3 className="font-semibold mb-1">Reset study data <span className="text-xs text-muted-foreground font-normal">(dev)</span></h3>
          <p className="text-xs text-muted-foreground mb-3">Wipes known words, quiz results, and study sessions, then sends you back to onboarding.</p>
          <Button variant="outline" onClick={resetStudyData}><Trash2 className="h-4 w-4" /> Reset study data</Button>
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

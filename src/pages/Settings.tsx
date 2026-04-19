import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { useAuth } from "@/context/AuthContext";
import { Settings as SettingsIcon, LogOut, RotateCw, Trash2, Film, Layers } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  useStudyPrefs,
  CHUNK_SIZE_MIN,
  CHUNK_SIZE_MAX,
  QUEUE_SIZE_MIN,
  QUEUE_SIZE_MAX,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_QUEUE_SIZE,
} from "@/hooks/use-study-prefs";

const JLPT_LEVELS = ["N5", "N4", "N3", "N2", "N1"] as const;
type JlptLevel = typeof JLPT_LEVELS[number];

// Common countries for streaming-region filtering. Extendable.
const COUNTRIES = [
  { code: "CH", name: "Switzerland" },
  { code: "US", name: "United States" },
  { code: "JP", name: "Japan" },
  { code: "GB", name: "United Kingdom" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
] as const;

export default function Settings() {
  const { profile, signOut, refreshProfile, user } = useAuth();
  const navigate = useNavigate();

  const setJlptLevel = async (level: JlptLevel) => {
    if (!user || profile?.jlpt_level === level) return;
    const { error } = await supabase
      .from("profiles")
      .update({ jlpt_level: level, placement_done: true })
      .eq("user_id", user.id);
    if (error) {
      toast.error("Couldn't update level");
      return;
    }
    await refreshProfile();
    toast.success(`Level set to ${level}`);
  };

  const setCountry = async (code: string | null) => {
    if (!user) return;
    const { error } = await supabase
      .from("profiles")
      .update({ country: code })
      .eq("user_id", user.id);
    if (error) {
      toast.error("Couldn't update country");
      return;
    }
    await refreshProfile();
    toast.success(code ? `Country set to ${code}` : "Country cleared");
  };

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

  const wipeAnimeData = async () => {
    if (!user) return;
    if (!confirm("Delete ALL anime data? This wipes the catalog (anime, episodes, subtitles, processed vocab) plus everyone's library and study chunks. Admin only.")) return;
    try {
      const { data, error } = await supabase.functions.invoke("wipe-anime-data", { body: {} });
      if (error) throw error;
      const counts = (data as any)?.counts ?? {};
      const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ");
      toast.success("Anime data deleted", { description: summary });
    } catch (e: any) {
      toast.error("Failed to delete anime data", { description: e?.message ?? "" });
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
          <h3 className="font-semibold mb-1">JLPT level</h3>
          <p className="text-xs text-muted-foreground mb-3">Set your level manually. This controls which words are skipped by default.</p>
          <div className="grid grid-cols-5 gap-2">
            {JLPT_LEVELS.map((lvl) => (
              <Button
                key={lvl}
                variant={profile?.jlpt_level === lvl ? "default" : "outline"}
                onClick={() => setJlptLevel(lvl)}
                className="h-10"
              >
                {lvl}
              </Button>
            ))}
          </div>
        </Card>

        <Card className="p-4 gradient-card border-border/50">
          <h3 className="font-semibold mb-1">Country</h3>
          <p className="text-xs text-muted-foreground mb-3">Used for region-aware streaming filters (e.g. Netflix availability).</p>
          <div className="flex flex-wrap gap-2">
            {COUNTRIES.map((c) => (
              <Button
                key={c.code}
                size="sm"
                variant={profile?.country === c.code ? "default" : "outline"}
                onClick={() => setCountry(c.code)}
                className="h-8"
              >
                {c.code} <span className="text-xs text-muted-foreground ml-1">{c.name}</span>
              </Button>
            ))}
            {profile?.country && (
              <Button size="sm" variant="ghost" onClick={() => setCountry(null)} className="h-8 text-xs">
                Clear
              </Button>
            )}
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
          <h3 className="font-semibold mb-1">Delete anime data <span className="text-xs text-muted-foreground font-normal">(admin)</span></h3>
          <p className="text-xs text-muted-foreground mb-3">Wipes the entire anime catalog (anime, episodes, subtitles, processed vocab) and everyone's libraries + study chunks. Profiles and known words are kept.</p>
          <Button variant="outline" onClick={wipeAnimeData}><Film className="h-4 w-4" /> Delete anime data</Button>
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

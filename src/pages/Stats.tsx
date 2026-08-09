import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { BarChart3 } from "lucide-react";
import { useI18n } from "@/i18n";

export default function Stats() {
  const { user, profile, learningLanguage } = useAuth();
  const { t } = useI18n();
  const [counts, setCounts] = useState({ known: 0, learning: 0, unknown: 0 });
  const [sessions, setSessions] = useState(0);

  useEffect(() => {
    (async () => {
      if (!user) return;
      const states: Array<"known" | "learning" | "unknown"> = ["known", "learning", "unknown"];
      const next = { known: 0, learning: 0, unknown: 0 };
      for (const s of states) {
        const { count } = await supabase.from("user_word_state").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("learning_language", learningLanguage).eq("state", s);
        next[s] = count ?? 0;
      }
      setCounts(next);
      const { count } = await supabase.from("study_sessions").select("id", { count: "exact", head: true }).eq("user_id", user.id).not("finished_at", "is", null);
      setSessions(count ?? 0);
    })();
  }, [user]);

  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader title={t("stats.title")} subtitle={t("stats.subtitle")} icon={<BarChart3 className="h-4 w-4" />} />
      <div className="px-5 grid grid-cols-2 gap-3">
        <StatCard label={t("stats.wordsKnown")} value={counts.known} accent="text-success" />
        <StatCard label={t("stats.learning")} value={counts.learning} accent="text-warning" />
        <StatCard label={t("stats.encountered")} value={counts.known + counts.learning + counts.unknown} accent="text-primary" />
        <StatCard label={t("stats.sessions")} value={sessions} accent="text-accent" />
        <StatCard label={t("stats.jlpt")} value={profile?.jlpt_level === "none" ? "—" : (profile?.jlpt_level ?? "—")} accent="text-secondary" />
        <StatCard label={t("stats.streak")} value={`${profile?.study_streak ?? 0}d`} accent="text-primary" />
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string | number; accent: string }) {
  return (
    <Card className="p-4 gradient-card border-border/50">
      <div className={`text-3xl font-bold ${accent}`}>{value}</div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground mt-1">{label}</div>
    </Card>
  );
}

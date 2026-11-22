import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { BarChart3 } from "lucide-react";
import { useI18n } from "@/i18n";
import { scaleLabel, formatLevel } from "@/lib/languages";
import { computeDailyStreak } from "@/lib/srs";

export default function Stats() {
  const { user, learningLanguage, progress } = useAuth();
  const { t } = useI18n();
  const [counts, setCounts] = useState({ known: 0, learning: 0, unknown: 0 });
  const [sessions, setSessions] = useState(0);
  const [streak, setStreak] = useState<number>(() => progress?.study_streak ?? 0);

  const userId = user?.id;

  useEffect(() => {
    setStreak(progress?.study_streak ?? 0);
  }, [progress?.study_streak]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const [
        knownRes,
        learningRes,
        unknownRes,
        sessionCountRes,
        reviewedWordsRes,
        sessionDatesRes,
      ] = await Promise.all([
        supabase
          .from("user_word_state")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("learning_language", learningLanguage)
          .eq("state", "known"),
        supabase
          .from("user_word_state")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("learning_language", learningLanguage)
          .eq("state", "learning"),
        supabase
          .from("user_word_state")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("learning_language", learningLanguage)
          .eq("state", "unknown"),
        supabase
          .from("study_sessions")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("learning_language", learningLanguage)
          .not("finished_at", "is", null),
        supabase
          .from("user_word_state")
          .select("last_reviewed_at")
          .eq("user_id", userId)
          .eq("learning_language", learningLanguage)
          .not("last_reviewed_at", "is", null)
          .order("last_reviewed_at", { ascending: false })
          .limit(1000),
        supabase
          .from("study_sessions")
          .select("started_at,finished_at")
          .eq("user_id", userId)
          .eq("learning_language", learningLanguage)
          .order("started_at", { ascending: false })
          .limit(500),
      ]);

      if (cancelled) return;

      setCounts({
        known: knownRes.count ?? 0,
        learning: learningRes.count ?? 0,
        unknown: unknownRes.count ?? 0,
      });
      setSessions(sessionCountRes.count ?? 0);

      const timestamps: Array<string | null> = [];
      for (const r of (reviewedWordsRes.data ?? []) as Array<{ last_reviewed_at: string | null }>) {
        timestamps.push(r.last_reviewed_at);
      }
      for (const s of (sessionDatesRes.data ?? []) as Array<{ started_at: string | null; finished_at: string | null }>) {
        timestamps.push(s.finished_at ?? s.started_at);
      }

      const computedStreak = computeDailyStreak(timestamps);
      setStreak(timestamps.length > 0 ? computedStreak : (progress?.study_streak ?? 0));
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, learningLanguage, progress?.study_streak]);

  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader title={t("stats.title")} subtitle={t("stats.subtitle")} icon={<BarChart3 className="h-4 w-4" />} />
      <div className="px-5 grid grid-cols-2 gap-3">
        <StatCard label={t("stats.wordsKnown")} value={counts.known} accent="text-success" />
        <StatCard label={t("stats.learning")} value={counts.learning} accent="text-warning" />
        <StatCard label={t("stats.encountered")} value={counts.known + counts.learning + counts.unknown} accent="text-primary" />
        <StatCard label={t("stats.sessions")} value={sessions} accent="text-accent" />
        <StatCard label={t("stats.level", { scale: scaleLabel(learningLanguage) })} value={formatLevel(progress?.level)} accent="text-foreground" />
        <StatCard label={t("stats.streak")} value={`${streak}d`} accent="text-primary" />
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

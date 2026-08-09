import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Sparkles, RefreshCw, Volume2, BookText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/i18n";
import { toast } from "sonner";

type Props = {
  episodeId: string;
  studiedWordCount: number;
};

type Summary = {
  summary_jp: string;
  summary_en: string;
  used_words: string[];
};

const TTS_LANG: Record<string, string> = { ja: "ja-JP", es: "es-ES", fr: "fr-FR", de: "de-DE" };
const ttsLangFor = (code: string) => TTS_LANG[code] ?? "en-US";

// Render text with **word** highlighted as primary-colored chips.
function HighlightedText({ text, hasRuby }: { text: string; hasRuby: boolean }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <p className={hasRuby ? "font-jp text-base leading-relaxed" : "text-base leading-relaxed"}>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**")) {
          const inner = p.slice(2, -2);
          return (
            <span
              key={i}
              className="px-1 py-0.5 rounded bg-primary/15 text-primary font-medium"
            >
              {inner}
            </span>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </p>
  );
}

export function EpisodeSummary({ episodeId, studiedWordCount }: Props) {
  const { user, learningLanguage, learningLanguageInfo } = useAuth();
  const { t } = useI18n();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [showEn, setShowEn] = useState(false);

  // Load cached summary on mount
  useEffect(() => {
    (async () => {
      if (!user || !episodeId) return;
      setLoading(true);
      const { data } = await supabase
        .from("episode_summaries")
        .select("summary_jp,summary_en,used_words")
        .eq("user_id", user.id).eq("episode_id", episodeId).eq("learning_language", learningLanguage).maybeSingle();
      if (data) setSummary(data as any);
      setLoading(false);
    })();
  }, [user, episodeId]);

  const generate = async (force = false) => {
    setGenerating(true);
    const { data, error } = await supabase.functions.invoke("episode-summary", {
      body: { episode_id: episodeId, force, learning_language: learningLanguage },
    });
    setGenerating(false);
    if (error) {
      toast.error(t("summary.failed"), { description: error.message });
      return;
    }
    if ((data as any)?.error) {
      toast.error(t("summary.failed"), { description: (data as any).error });
      return;
    }
    setSummary({
      summary_jp: data.summary_jp,
      summary_en: data.summary_en,
      used_words: data.used_words ?? [],
    });
    if (!data.cached) toast.success(t("summary.ready"));
  };

  const speak = (text: string) => {
    if (!("speechSynthesis" in window)) return;
    // Strip ** markers before speaking
    const clean = text.replace(/\*\*/g, "");
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = ttsLangFor(learningLanguage);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  };

  if (loading) return null;

  // Empty state — prompt user to generate
  if (!summary) {
    return (
      <Card className="p-4 mb-6 gradient-card border-border/50">
        <div className="flex items-start gap-3">
          <div className="rounded-md p-2 bg-primary/10 text-primary shrink-0">
            <BookText className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold mb-1">{t("summary.title")}</h3>
            <p className="text-xs text-muted-foreground mb-3">
              {t("summary.explain")}
            </p>
            <Button
              size="sm"
              className="gradient-primary text-primary-foreground h-9"
              onClick={() => generate(false)}
              disabled={generating || studiedWordCount === 0}
              title={studiedWordCount === 0 ? t("summary.studyFirst") : ""}
            >
              {generating ? <><Loader2 className="h-4 w-4 animate-spin" /> {t("summary.generating")}</> : <><Sparkles className="h-4 w-4" /> {t("summary.generate")}</>}
            </Button>
            {studiedWordCount === 0 && (
              <div className="text-[11px] text-muted-foreground mt-2">{t("summary.studyFirstHint")}</div>
            )}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-4 mb-6 gradient-card border-border/50">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold flex items-center gap-2">
          <BookText className="h-4 w-4 text-primary" /> {t("summary.title")}
        </h3>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => speak(summary.summary_jp)}>
            <Volume2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => generate(true)}
            disabled={generating}
            title={t("summary.regenerate")}
          >
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      <HighlightedText text={summary.summary_jp} hasRuby={learningLanguageInfo.hasRuby} />

      <div className="mt-3">
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          onClick={() => setShowEn(s => !s)}
        >
          {showEn ? t("summary.hide") : t("summary.show")} {t("summary.translation")}
        </Button>
        {showEn && (
          <div className="mt-2">
            <HighlightedText text={summary.summary_en} hasRuby={false} />
          </div>
        )}
      </div>

      {summary.used_words.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-3 pt-3 border-t border-border/40">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1 self-center">{t("summary.used")}</span>
          {summary.used_words.map((w, i) => (
            <Badge key={i} variant="secondary" className={learningLanguageInfo.hasRuby ? "text-[10px] font-jp" : "text-[10px]"}>{w}</Badge>
          ))}
        </div>
      )}
    </Card>
  );
}

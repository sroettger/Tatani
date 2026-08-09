import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";
import { useI18n } from "@/i18n";
import { levelsFor, levelRank, levelFromRank, getLearningLanguage } from "@/lib/languages";

type Question = {
  prompt: string;
  /** Word in the target language. `jp_word` kept for backwards compatibility. */
  word?: string;
  jp_word?: string;
  reading: string;
  choices: string[];
  correct_index: number;
  level?: string;
  jlpt_level?: string;
};

type Phase = "intro" | "loading" | "quiz" | "result";

const qWord = (q: Question) => q.word ?? q.jp_word ?? "";
const qLevel = (q: Question) => q.level ?? q.jlpt_level ?? "";

export default function Onboarding() {
  const { user, refreshProfile, progress: langProgress, learningLanguage } = useAuth();
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const langInfo = getLearningLanguage(learningLanguage);
  const levels = levelsFor(learningLanguage);
  const [phase, setPhase] = useState<Phase>("intro");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<{ q: Question; correct: boolean }[]>([]);
  const [resultLevel, setResultLevel] = useState<string>(levels[0]);

  useEffect(() => {
    if (langProgress?.placement_done) navigate("/", { replace: true });
  }, [langProgress, navigate]);

  const startQuiz = async () => {
    setPhase("loading");
    const { data, error } = await supabase.functions.invoke("placement-quiz-generate", {
      body: { learning_language: learningLanguage, ui_language: lang },
    });
    if (error || !data?.questions) {
      toast.error(t("onboarding.failed"), { description: error?.message ?? t("onboarding.failedBody") });
      setPhase("intro");
      return;
    }
    setQuestions(data.questions);
    setIdx(0);
    setAnswers([]);
    setPhase("quiz");
  };

  const current = questions[idx];

  const pickAnswer = async (choiceIdx: number) => {
    if (!current) return;
    const correct = choiceIdx === current.correct_index;
    const next = [...answers, { q: current, correct }];
    setAnswers(next);
    if (idx + 1 < questions.length) {
      setIdx(idx + 1);
    } else {
      // compute level: highest level where they got >=50% correct
      const byLevel: Record<string, { c: number; t: number }> = {};
      for (const a of next) {
        const k = qLevel(a.q);
        byLevel[k] = byLevel[k] || { c: 0, t: 0 };
        byLevel[k].t += 1;
        if (a.correct) byLevel[k].c += 1;
      }
      let bestRank = 1;
      for (let r = levels.length; r >= 1; r--) {
        const stat = byLevel[levels[r - 1]];
        if (stat && stat.c / stat.t >= 0.5) { bestRank = r; break; }
      }
      const level = levelFromRank(learningLanguage, bestRank);
      setResultLevel(level);

      // Seed known words: every word answered correctly + every word at or below level
      if (user) {
        const seedRows = next
          .filter((a) => a.correct || levelRank(learningLanguage, qLevel(a.q)) <= bestRank)
          .map((a) => ({
            user_id: user.id,
            word: qWord(a.q),
            reading: a.q.reading ?? null,
            state: "known" as const,
            level: qLevel(a.q) || null,
            learning_language: learningLanguage,
          }))
          .filter((r) => r.word);
        if (seedRows.length) {
          await supabase.from("user_word_state").upsert(seedRows, { onConflict: "user_id,word,learning_language" });
        }
        await supabase
          .from("user_language_progress")
          .update({ level, placement_done: true })
          .eq("user_id", user.id)
          .eq("learning_language", learningLanguage);
        await refreshProfile();
      }
      setPhase("result");
    }
  };

  const progress = useMemo(() => (questions.length ? Math.round((idx / questions.length) * 100) : 0), [idx, questions.length]);

  if (phase === "intro") {
    return (
      <main className="min-h-screen gradient-hero grid place-items-center px-5 py-10">
        <Card className="w-full max-w-md p-8 gradient-card border-border/50 shadow-card animate-fade-in">
          <div className="flex justify-center mb-4">
            <div className="h-14 w-14 rounded-2xl gradient-primary grid place-items-center shadow-elegant">
              <Sparkles className="h-7 w-7 text-primary-foreground" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-center mb-2">{t("onboarding.welcome")}</h1>
          <p className="text-sm text-muted-foreground text-center mb-8">
            {t("onboarding.intro", { lang: langInfo.native })}
          </p>
          <Button onClick={startQuiz} className="w-full h-12 gradient-primary text-primary-foreground">
            {t("onboarding.start")}
          </Button>
        </Card>
      </main>
    );
  }

  if (phase === "loading") {
    return (
      <main className="min-h-screen grid place-items-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          {t("onboarding.generating")}
        </div>
      </main>
    );
  }

  if (phase === "result") {
    return (
      <main className="min-h-screen gradient-hero grid place-items-center px-5">
        <Card className="w-full max-w-md p-8 text-center gradient-card border-border/50 shadow-card animate-fade-in">
          <div className="text-xs uppercase tracking-widest text-primary font-semibold mb-2">{t("onboarding.yourLevel")}</div>
          <div className="text-6xl font-bold gradient-primary bg-clip-text text-transparent mb-4">{resultLevel}</div>
          <p className="text-sm text-muted-foreground mb-6">
            {t("onboarding.levelBody")}
          </p>
          <Button onClick={() => navigate("/")} className="w-full h-12 gradient-primary text-primary-foreground">
            {t("onboarding.continue")}
          </Button>
        </Card>
      </main>
    );
  }

  // quiz phase
  return (
    <main className="min-h-screen bg-background px-5 py-8">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-muted-foreground">{t("onboarding.question", { n: idx + 1, total: questions.length })}</span>
          <span className="text-xs text-primary font-semibold">{current ? qLevel(current) : ""}</span>
        </div>
        <Progress value={progress} className="mb-8 h-2" />

        <Card className="p-6 gradient-card border-border/50 shadow-card mb-6 animate-fade-in" key={idx}>
          <div className="text-center py-4">
            <div className="text-xs text-muted-foreground mb-2">{current?.prompt || t("onboarding.defaultPrompt")}</div>
            <div className={`text-5xl font-bold mb-2 ${langInfo.hasRuby ? "font-jp" : ""}`}>{current ? qWord(current) : ""}</div>
            {langInfo.hasRuby && current?.reading && <div className="font-jp text-muted-foreground">{current.reading}</div>}
          </div>
        </Card>

        <div className="grid gap-2">
          {current?.choices.map((c, i) => (
            <Button
              key={i}
              variant="outline"
              className="h-auto min-h-12 py-3 text-left justify-start whitespace-normal"
              onClick={() => pickAnswer(i)}
            >
              <span className="text-muted-foreground mr-3">{String.fromCharCode(65 + i)}.</span>
              <span className="flex-1">{c}</span>
            </Button>
          ))}
          <Button
            variant="ghost"
            className="h-12 mt-2 text-muted-foreground"
            onClick={() => pickAnswer(-1)}
          >
            {t("onboarding.dontKnow")}
          </Button>
        </div>
      </div>
    </main>
  );
}

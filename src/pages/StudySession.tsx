import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ChevronLeft, Volume2, Check, X, RotateCw, Languages } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TutorChat } from "@/components/TutorChat";
import { Furigana } from "@/components/Furigana";
import { useI18n } from "@/i18n";
import { levelRank } from "@/lib/languages";
import {
  computeNextSrsState,
  KnownSourceKind,
  WordPreferenceKind,
  WordSrsRecord,
  WordStateKind,
} from "@/lib/srs";
import { invalidateLocalSrsCache } from "@/lib/srs-store";
import { fetchBatchedPages } from "@/lib/supabase-pagination";
import { cn } from "@/lib/utils";

const TTS_LANG: Record<string, string> = { ja: "ja-JP", es: "es-ES", fr: "fr-FR", de: "de-DE" };
const ttsLangFor = (code: string) => TTS_LANG[code] ?? "en-US";

type VocabItem = {
  word: string;
  reading: string;
  meaning: string;
  part_of_speech: string;
  jlpt_level?: string;
  level?: string;
  example_sentence_jp: string;
  example_sentence_en: string;
};

type StateDbRow = {
  word: string;
  reading: string | null;
  level: string | null;
  state: string | null;
  preference: string | null;
  known_source: string | null;
  correct_streak: number | null;
  srs_level: number | null;
  srs_due_at: string | null;
  last_reviewed_at: string | null;
  marked_known_at: string | null;
};

const KANJI_THRESHOLD = 2;
const getLevel = (v: VocabItem) => v.level ?? v.jlpt_level ?? "none";

export default function StudySession() {
  const { episodeId } = useParams();
  const navigate = useNavigate();
  const { user, learningLanguage, learningLanguageInfo, progress } = useAuth();
  const { t } = useI18n();
  const [vocab, setVocab] = useState<VocabItem[]>([]);
  const [knownWords, setKnownWords] = useState<Set<string>>(new Set());
  const [streaks, setStreaks] = useState<Record<string, number>>({});
  const [sessionId, setSessionId] = useState<string | null>(null);
  const wordRecordsRef = useRef<Record<string, WordSrsRecord>>({});

  // review state
  const [reviewIdx, setReviewIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reviewedKnown, setReviewedKnown] = useState(0);

  // quiz state
  const [quizIdx, setQuizIdx] = useState(0);
  const [quizCorrect, setQuizCorrect] = useState(0);
  const [quizChoice, setQuizChoice] = useState<number | null>(null);

  const [done, setDone] = useState<"none" | "review" | "quiz">("none");
  const [showFurigana, setShowFurigana] = useState(false);

  const userId = user?.id;

  useEffect(() => {
    if (!episodeId || !userId) return;
    let cancelled = false;
    (async () => {
      const { data: cache } = await supabase
        .from("episode_vocab_cache")
        .select("vocab")
        .eq("episode_id", episodeId)
        .eq("language", learningLanguage)
        .maybeSingle();
      if (cancelled) return;

      const all = (Array.isArray(cache?.vocab) ? cache.vocab : []) as VocabItem[];
      const epWords = Array.from(new Set(all.map((v) => v.word).filter(Boolean)));

      const { data: stateRows } = epWords.length > 0
        ? await fetchBatchedPages<string, StateDbRow>(epWords, 200, (slice, from, to) =>
            supabase
              .from("user_word_state")
              .select("word,reading,level,state,preference,known_source,correct_streak,srs_level,srs_due_at,last_reviewed_at,marked_known_at")
              .eq("user_id", userId)
              .eq("learning_language", learningLanguage)
              .in("word", slice)
              .order("word", { ascending: true })
              .range(from, to),
          )
        : { data: [] as StateDbRow[] };
      if (cancelled) return;

      const knownSet = new Set<string>();
      const trackedSet = new Set<string>();
      const streakMap: Record<string, number> = {};
      const recordMap: Record<string, WordSrsRecord> = {};

      for (const s of stateRows) {
        trackedSet.add(s.word);
        if (s.state === "known") knownSet.add(s.word);
        streakMap[s.word] = s.correct_streak ?? 0;
        recordMap[s.word] = {
          word: s.word,
          reading: s.reading ?? null,
          level: s.level ?? null,
          state: (s.state ?? "unknown") as WordStateKind,
          preference: (s.preference ?? "study") as WordPreferenceKind,
          known_source: (s.known_source ?? null) as KnownSourceKind,
          correct_streak: s.correct_streak ?? 0,
          srs_level: s.srs_level ?? 0,
          srs_due_at: s.srs_due_at ?? null,
          last_reviewed_at: s.last_reviewed_at ?? null,
          marked_known_at: s.marked_known_at ?? null,
        };
      }

      wordRecordsRef.current = recordMap;
      setKnownWords(knownSet);
      setStreaks(streakMap);

      const myRank = levelRank(learningLanguage, progress?.level);
      const isBelowLevel = (lvl: string) => myRank > 0 && (levelRank(learningLanguage, lvl) || 99) < myRank;

      setVocab(
        all.filter(
          (v) => !knownSet.has(v.word) && (!isBelowLevel(getLevel(v)) || trackedSet.has(v.word)),
        ),
      );

      const { data: sess } = await supabase
        .from("study_sessions")
        .insert({
          user_id: userId,
          episode_id: episodeId,
          mode: "review",
          words_studied: 0,
          words_mastered: 0,
          learning_language: learningLanguage,
        })
        .select("id")
        .single();
      if (!cancelled && sess) setSessionId(sess.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [episodeId, userId, progress?.level, learningLanguage]);

  const quizVocab = useMemo(
    () => vocab.filter((v) => !knownWords.has(v.word)),
    [vocab, knownWords],
  );

  const reviewCard = vocab[reviewIdx];
  const quizCard = quizVocab[quizIdx];

  const recordWordOptimistic = (word: string, reading: string, level: string, gotItRight: boolean) => {
    const prevRecord = wordRecordsRef.current[word];
    const nextRecord = computeNextSrsState(
      prevRecord,
      {
        word,
        reading: reading || null,
        level: level === "none" ? null : level,
      },
      gotItRight,
    );
    wordRecordsRef.current[word] = nextRecord;
    setStreaks((prev) => ({ ...prev, [word]: nextRecord.correct_streak }));
    if (gotItRight) {
      setKnownWords((prev) => new Set([...prev, word]));
    }
    if (!user) return;

    void supabase
      .from("user_word_state")
      .upsert(
        {
          user_id: user.id,
          word: nextRecord.word,
          reading: nextRecord.reading,
          level: nextRecord.level,
          learning_language: learningLanguage,
          state: nextRecord.state,
          preference: nextRecord.preference,
          known_source: nextRecord.known_source,
          correct_streak: nextRecord.correct_streak,
          srs_level: nextRecord.srs_level,
          srs_due_at: nextRecord.srs_due_at,
          last_reviewed_at: nextRecord.last_reviewed_at,
          marked_known_at: nextRecord.marked_known_at ?? null,
        },
        { onConflict: "user_id,word,learning_language" },
      )
      .then(() => {
        invalidateLocalSrsCache(user.id, learningLanguage);
      });
  };

  const finish = async (mode: "review" | "quiz", masteredOverride?: number) => {
    setDone(mode);
    if (sessionId) {
      await supabase.from("study_sessions").update({
        finished_at: new Date().toISOString(),
        words_studied: vocab.length,
        words_mastered: masteredOverride ?? (mode === "review" ? reviewedKnown : quizCorrect),
        mode,
      }).eq("id", sessionId);
    }
  };

  const nextReview = (nextMastered?: number) => {
    setFlipped(false);
    setShowFurigana(false);
    if (reviewIdx + 1 < vocab.length) setReviewIdx(reviewIdx + 1);
    else void finish("review", nextMastered);
  };

  const onReviewKnow = () => {
    if (!reviewCard) return;
    const nextKnown = reviewedKnown + 1;
    setReviewedKnown(nextKnown);
    recordWordOptimistic(reviewCard.word, reviewCard.reading, getLevel(reviewCard), true);
    nextReview(nextKnown);
  };

  const onReviewLearning = () => {
    if (!reviewCard) return;
    recordWordOptimistic(reviewCard.word, reviewCard.reading, getLevel(reviewCard), false);
    nextReview(reviewedKnown);
  };

  const distractors = useMemo(() => {
    if (!quizCard) return [];
    const others = quizVocab.filter((v) => v.word !== quizCard.word).map((v) => v.meaning);
    const shuffled = [...others].sort(() => Math.random() - 0.5).slice(0, 3);
    const all = [quizCard.meaning, ...shuffled];
    return all.sort(() => Math.random() - 0.5);
  }, [quizCard, quizVocab]);

  const correctIndex = useMemo(() => distractors.indexOf(quizCard?.meaning ?? ""), [distractors, quizCard]);

  const onQuizAnswer = (i: number) => {
    if (!quizCard || quizChoice !== null) return;
    setQuizChoice(i);
    const correct = i === correctIndex;
    const nextCorrect = correct ? quizCorrect + 1 : quizCorrect;
    if (correct) setQuizCorrect(nextCorrect);
    if (sessionId && user) {
      void supabase.from("quiz_results").insert({
        session_id: sessionId,
        user_id: user.id,
        word: quizCard.word,
        was_correct: correct,
        quiz_kind: "jp_to_meaning",
        learning_language: learningLanguage,
      });
    }
    recordWordOptimistic(quizCard.word, quizCard.reading, getLevel(quizCard), correct);
    setTimeout(() => {
      setQuizChoice(null);
      if (quizIdx + 1 < quizVocab.length) setQuizIdx(quizIdx + 1);
      else void finish("quiz", nextCorrect);
    }, 280);
  };

  const speak = (text: string) => {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = ttsLangFor(learningLanguage);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  };

  if (vocab.length === 0) {
    return (
      <div className="max-w-2xl mx-auto px-5 py-10 text-center">
        <p className="text-muted-foreground mb-4">{t("study.noNewTitle")}</p>
        <Button onClick={() => navigate(-1)}>{t("study.back")}</Button>
      </div>
    );
  }

  if (done !== "none") {
    return (
      <div className="max-w-md mx-auto px-5 py-10 text-center">
        <Card className="p-8 gradient-card border-border/50 shadow-card animate-fade-in">
          <div className="text-5xl mb-3">🎉</div>
          <h2 className="text-2xl font-bold mb-2">{t("study.greatJob")}</h2>
          <p className="text-sm text-muted-foreground mb-6">
            {done === "review"
              ? t("study.markedKnownOf", { known: reviewedKnown, total: vocab.length })
              : t("study.gotCorrectOf", { correct: quizCorrect, total: quizVocab.length })}
          </p>
          <div className="grid gap-2">
            <Button onClick={() => navigate(`/episode/${episodeId}`)} className="gradient-primary text-primary-foreground">{t("study.backToEpisode")}</Button>
            <Button variant="outline" onClick={() => { setDone("none"); setReviewIdx(0); setQuizIdx(0); setQuizCorrect(0); setReviewedKnown(0); }}>
              <RotateCw className="h-4 w-4" /> {t("study.studyAgain")}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-5 pt-4 pb-10">
      <div className="flex items-center justify-between mb-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}><ChevronLeft className="h-5 w-5" /></Button>
        <div className="text-sm text-muted-foreground">{t("study.title")}</div>
        <div className="w-9" />
      </div>

      <Tabs defaultValue="quiz" className="w-full">
        <TabsList className="grid grid-cols-2 w-full mb-6">
          <TabsTrigger value="review">{t("study.review")}</TabsTrigger>
          <TabsTrigger value="quiz">{t("study.quiz")}</TabsTrigger>
        </TabsList>

        <TabsContent value="review">
          <Progress value={(reviewIdx / vocab.length) * 100} className="h-2 mb-4" />
          <div className="text-xs text-muted-foreground text-center mb-4">{reviewIdx + 1} / {vocab.length}</div>

          <div className="flip-card h-72 mb-4" onClick={() => setFlipped((f) => !f)}>
            <div className={`flip-inner h-full ${flipped ? "flipped" : ""}`}>
              <Card className="flip-face absolute inset-0 gradient-card border-border/50 shadow-card grid place-items-center cursor-pointer">
                <div className="text-center px-6">
                  {(() => {
                    const showKanji = !reviewCard ? false : (streaks[reviewCard.word] ?? 0) >= KANJI_THRESHOLD || reviewCard.word === reviewCard.reading;
                    const display = learningLanguageInfo.hasRuby ? ((showKanji ? reviewCard?.word : reviewCard?.reading) || reviewCard?.word) : reviewCard?.word;
                    return (
                      <>
                        <div className={cn("text-6xl font-bold mb-2", learningLanguageInfo.hasRuby && "font-jp")}>
                          {display}
                        </div>
                        {learningLanguageInfo.hasRuby && !showKanji && reviewCard && reviewCard.word !== reviewCard.reading && (
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{t("study.hiraganaMode")}</div>
                        )}
                        <div className="text-xs text-muted-foreground">{t("study.tapToFlip")}</div>
                      </>
                    );
                  })()}
                </div>
              </Card>
              <Card className="flip-face flip-back gradient-card border-primary/30 shadow-elegant grid place-items-center cursor-pointer relative">
                {learningLanguageInfo.hasRuby && (
                  <Button
                    variant={showFurigana ? "default" : "ghost"}
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); setShowFurigana((v) => !v); }}
                    aria-pressed={showFurigana}
                    title={t("study.toggleFurigana")}
                    className="absolute top-2 right-2 h-8 gap-1 px-2 z-10"
                  >
                    <Languages className="h-3.5 w-3.5" />
                    <span className="font-jp text-[11px]">あ</span>
                  </Button>
                )}
                <div className="text-center px-6">
                  {learningLanguageInfo.hasRuby ? (
                    <Furigana text={reviewCard?.word ?? ""} show={showFurigana} className="font-jp text-3xl font-bold mb-3 inline-block" />
                  ) : (
                    <div className="text-3xl font-bold mb-3">{reviewCard?.word}</div>
                  )}
                  <div className="text-lg font-semibold mb-3">{reviewCard?.meaning}</div>
                  <div className="text-xs text-muted-foreground italic">{reviewCard?.part_of_speech} • {getLevel(reviewCard ?? { word: "", reading: "", meaning: "", part_of_speech: "", example_sentence_jp: "", example_sentence_en: "" })}</div>
                  {reviewCard?.example_sentence_jp && (
                    <div className="mt-4 text-xs">
                      {learningLanguageInfo.hasRuby ? (
                        <Furigana text={reviewCard.example_sentence_jp} show={showFurigana} className="font-jp text-sm leading-loose" />
                      ) : (
                        <div className="text-sm leading-loose">{reviewCard.example_sentence_jp}</div>
                      )}
                      <div className="text-muted-foreground mt-1">{reviewCard.example_sentence_en}</div>
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </div>

          <div className="flex justify-center mb-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                if (reviewCard) {
                  speak(reviewCard.reading || reviewCard.word);
                }
              }}
            >
              <Volume2 className="h-4 w-4" /> {t("study.playAudio")}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={onReviewLearning} className="h-12">
              <X className="h-4 w-4" /> {t("study.stillLearning")}
            </Button>
            <Button onClick={onReviewKnow} className="h-12 bg-success text-success-foreground hover:bg-success/90">
              <Check className="h-4 w-4" /> {t("study.iKnowThis")}
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="quiz">
          {quizVocab.length === 0 ? (
            <Card className="p-8 gradient-card border-border/50 text-center">
              <p className="text-sm text-muted-foreground">
                {t("study.nothingToQuiz")}
              </p>
            </Card>
          ) : (
            <>
              <Progress value={(quizIdx / quizVocab.length) * 100} className="h-2 mb-4" />
              <div className="text-xs text-muted-foreground text-center mb-4">{Math.min(quizIdx + 1, quizVocab.length)} / {quizVocab.length}</div>

              <Card className="p-6 gradient-card border-border/50 shadow-card mb-4 text-center">
                <div className="text-xs text-muted-foreground mb-2">{t("study.whatDoesThisMean")}</div>
                {(() => {
                  const showKanji = !quizCard ? false : (streaks[quizCard.word] ?? 0) >= KANJI_THRESHOLD || quizCard.word === quizCard.reading;
                  return (
                    <>
                      <div className={cn("text-5xl font-bold mb-2", learningLanguageInfo.hasRuby && "font-jp")}>
                        {learningLanguageInfo.hasRuby ? ((showKanji ? quizCard?.word : quizCard?.reading) || quizCard?.word) : quizCard?.word}
                      </div>
                      {learningLanguageInfo.hasRuby && (showKanji
                        ? <div className="font-jp text-muted-foreground">{quizCard?.reading}</div>
                        : quizCard && quizCard.word !== quizCard.reading && <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("study.hiraganaMode")}</div>)}
                    </>
                  );
                })()}
              </Card>

              <div className="grid gap-2">
                {distractors.map((d, i) => {
                  const isPicked = quizChoice === i;
                  const isCorrect = i === correctIndex;
                  const showState = quizChoice !== null;
                  return (
                    <Button
                      key={i}
                      variant="outline"
                      onClick={(e) => { e.currentTarget.blur(); onQuizAnswer(i); }}
                      disabled={quizChoice !== null}
                      className={`h-auto min-h-12 py-3 text-left justify-start whitespace-normal ${
                        showState && isCorrect ? "border-success bg-success/10" :
                        showState && isPicked && !isCorrect ? "border-destructive bg-destructive/10" : ""
                      }`}
                    >
                      <span className="text-muted-foreground mr-3">{String.fromCharCode(65 + i)}.</span>
                      <span className="flex-1">{d}</span>
                    </Button>
                  );
                })}
                <Button
                  variant="ghost"
                  onClick={() => onQuizAnswer(-1)}
                  disabled={quizChoice !== null}
                  className="h-12 mt-2 text-muted-foreground"
                >
                  {t("study.dontKnow")}
                </Button>
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>

      <TutorChat
        vocab={vocab}
        focusWord={reviewCard?.word ?? quizCard?.word ?? null}
        onWordMarkedKnown={(w) => setKnownWords((prev) => new Set([...prev, w]))}
      />
    </div>
  );
}

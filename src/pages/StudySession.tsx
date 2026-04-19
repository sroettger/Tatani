import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ChevronLeft, Volume2, Check, X, RotateCw, Languages } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { TutorChat } from "@/components/TutorChat";
import { Furigana } from "@/components/Furigana";

type VocabItem = {
  word: string; reading: string; meaning: string; part_of_speech: string;
  jlpt_level: string; example_sentence_jp: string; example_sentence_en: string;
};

export default function StudySession() {
  const { episodeId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [vocab, setVocab] = useState<VocabItem[]>([]);
  const [knownWords, setKnownWords] = useState<Set<string>>(new Set());
  // word -> current correct_streak; words at >=2 show kanji, otherwise hiragana
  const [streaks, setStreaks] = useState<Record<string, number>>({});
  const KANJI_THRESHOLD = 2;
  const [sessionId, setSessionId] = useState<string | null>(null);

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

  // JLPT difficulty rank — must match EpisodeDetail. "none" treated as harder than N1.
  const JLPT_RANK: Record<string, number> = { N5: 1, N4: 2, N3: 3, N2: 4, N1: 5, none: 6 };

  useEffect(() => {
    if (!episodeId || !user) return;
    (async () => {
      const { data: cache } = await supabase.from("episode_vocab_cache").select("vocab").eq("episode_id", episodeId).maybeSingle();
      const all = ((cache?.vocab ?? []) as VocabItem[]);
      const { data: states } = await supabase
        .from("user_word_state")
        .select("word,state,correct_streak")
        .eq("user_id", user.id);
      const knownSet = new Set((states ?? []).filter((k: any) => k.state === "known").map((k: any) => k.word));
      // Words the user has explicitly interacted with (added back, learning, etc.) — never auto-skip these.
      const trackedSet = new Set((states ?? []).map((k: any) => k.word));
      const streakMap: Record<string, number> = {};
      (states ?? []).forEach((s: any) => { streakMap[s.word] = s.correct_streak ?? 0; });
      setKnownWords(knownSet);
      setStreaks(streakMap);

      // Apply same JLPT-level filter as EpisodeDetail: skip words below the user's level
      // unless they were explicitly added back / are being tracked.
      const myLevel = profile?.jlpt_level && profile.jlpt_level !== "none" ? profile.jlpt_level : null;
      const myRank = myLevel ? JLPT_RANK[myLevel] : 0;
      const isBelowLevel = (lvl: string) => myRank > 0 && (JLPT_RANK[lvl] ?? 99) < myRank;

      setVocab(all.filter(v =>
        !knownSet.has(v.word) &&
        (!isBelowLevel(v.jlpt_level) || trackedSet.has(v.word))
      ));

      const { data: sess } = await supabase
        .from("study_sessions")
        .insert({ user_id: user.id, episode_id: episodeId, mode: "review", words_studied: 0, words_mastered: 0 })
        .select("id").single();
      if (sess) setSessionId(sess.id);
    })();
  }, [episodeId, user, profile?.jlpt_level]);

  // Quiz only shows words the user hasn't already marked as known (either before
  // this session or during the review tab). Review keeps the original list so users
  // can still see/skip cards in order.
  const quizVocab = useMemo(
    () => vocab.filter(v => !knownWords.has(v.word)),
    [vocab, knownWords],
  );

  const reviewCard = vocab[reviewIdx];
  const quizCard = quizVocab[quizIdx];

  const recordWord = async (word: string, reading: string, jlpt: string, gotItRight: boolean) => {
    if (!user) return;
    const { data: existing } = await supabase
      .from("user_word_state").select("correct_streak").eq("user_id", user.id).eq("word", word).maybeSingle();
    const prevStreak = existing?.correct_streak ?? 0;
    const newStreak = gotItRight ? prevStreak + 1 : 0;

    // Note: state is only changed via manual marking on the episode page.
    await supabase.from("user_word_state").upsert({
      user_id: user.id, word, reading, jlpt_level: (jlpt as any) ?? null,
      correct_streak: newStreak, last_reviewed_at: new Date().toISOString(),
    }, { onConflict: "user_id,word" });
    setStreaks(prev => ({ ...prev, [word]: newStreak }));
  };

  const onReviewKnow = async () => {
    if (!reviewCard) return;
    await recordWord(reviewCard.word, reviewCard.reading, reviewCard.jlpt_level, true);
    nextReview();
  };
  const onReviewLearning = async () => {
    if (!reviewCard) return;
    await recordWord(reviewCard.word, reviewCard.reading, reviewCard.jlpt_level, false);
    nextReview();
  };
  const nextReview = () => {
    setFlipped(false);
    setShowFurigana(false);
    if (reviewIdx + 1 < vocab.length) setReviewIdx(reviewIdx + 1);
    else finish("review");
  };

  const distractors = useMemo(() => {
    if (!quizCard) return [];
    const others = quizVocab.filter(v => v.word !== quizCard.word).map(v => v.meaning);
    const shuffled = [...others].sort(() => Math.random() - 0.5).slice(0, 3);
    const all = [quizCard.meaning, ...shuffled];
    return all.sort(() => Math.random() - 0.5);
  }, [quizCard, quizVocab]);

  const correctIndex = useMemo(() => distractors.indexOf(quizCard?.meaning ?? ""), [distractors, quizCard]);

  const onQuizAnswer = async (i: number) => {
    if (!quizCard || quizChoice !== null) return;
    setQuizChoice(i);
    const correct = i === correctIndex;
    if (correct) setQuizCorrect(c => c + 1);
    if (sessionId && user) {
      await supabase.from("quiz_results").insert({
        session_id: sessionId, user_id: user.id, word: quizCard.word,
        was_correct: correct, quiz_kind: "jp_to_meaning",
      });
    }
    await recordWord(quizCard.word, quizCard.reading, quizCard.jlpt_level, correct);
    setTimeout(() => {
      setQuizChoice(null);
      if (quizIdx + 1 < quizVocab.length) setQuizIdx(quizIdx + 1);
      else finish("quiz");
    }, 900);
  };

  const finish = async (mode: "review" | "quiz") => {
    setDone(mode);
    if (sessionId) {
      await supabase.from("study_sessions").update({
        finished_at: new Date().toISOString(),
        words_studied: vocab.length,
        words_mastered: mode === "review" ? reviewedKnown : quizCorrect,
        mode,
      }).eq("id", sessionId);
    }
  };

  const speak = (text: string) => {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  };

  if (vocab.length === 0) {
    return (
      <div className="max-w-2xl mx-auto px-5 py-10 text-center">
        <p className="text-muted-foreground mb-4">No new words to study — you already know everything in this episode!</p>
        <Button onClick={() => navigate(-1)}>Back</Button>
      </div>
    );
  }

  if (done !== "none") {
    return (
      <div className="max-w-md mx-auto px-5 py-10 text-center">
        <Card className="p-8 gradient-card border-border/50 shadow-card animate-fade-in">
          <div className="text-5xl mb-3">🎉</div>
          <h2 className="text-2xl font-bold mb-2">Great job!</h2>
          <p className="text-sm text-muted-foreground mb-6">
            {done === "review"
              ? `You marked ${reviewedKnown} as known out of ${vocab.length}.`
              : `You got ${quizCorrect} / ${quizVocab.length} correct.`}
          </p>
          <div className="grid gap-2">
            <Button onClick={() => navigate(`/episode/${episodeId}`)} className="gradient-primary text-primary-foreground">Back to episode</Button>
            <Button variant="outline" onClick={() => { setDone("none"); setReviewIdx(0); setQuizIdx(0); setQuizCorrect(0); setReviewedKnown(0); }}>
              <RotateCw className="h-4 w-4" /> Study again
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
        <div className="text-sm text-muted-foreground">Study</div>
        <div className="w-9" />
      </div>

      <Tabs defaultValue="quiz" className="w-full">
        <TabsList className="grid grid-cols-2 w-full mb-6">
          <TabsTrigger value="review">Review</TabsTrigger>
          <TabsTrigger value="quiz">Quiz</TabsTrigger>
        </TabsList>

        <TabsContent value="review">
          <Progress value={(reviewIdx / vocab.length) * 100} className="h-2 mb-4" />
          <div className="text-xs text-muted-foreground text-center mb-4">{reviewIdx + 1} / {vocab.length}</div>

          <div className="flip-card h-72 mb-4" onClick={() => setFlipped(f => !f)}>
            <div className={`flip-inner h-full ${flipped ? "flipped" : ""}`}>
              <Card className="flip-face absolute inset-0 gradient-card border-border/50 shadow-card grid place-items-center cursor-pointer">
                <div className="text-center px-6">
                  {(() => {
                    const showKanji = !reviewCard ? false : (streaks[reviewCard.word] ?? 0) >= KANJI_THRESHOLD || reviewCard.word === reviewCard.reading;
                    return (
                      <>
                        <div className="font-jp text-6xl font-bold mb-2">
                          {showKanji ? reviewCard?.word : reviewCard?.reading}
                        </div>
                        {!showKanji && reviewCard && reviewCard.word !== reviewCard.reading && (
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Hiragana mode</div>
                        )}
                        <div className="text-xs text-muted-foreground">Tap to flip</div>
                      </>
                    );
                  })()}
                </div>
              </Card>
              <Card className="flip-face flip-back gradient-card border-primary/30 shadow-elegant grid place-items-center cursor-pointer relative">
                <Button
                  variant={showFurigana ? "default" : "ghost"}
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); setShowFurigana(v => !v); }}
                  aria-pressed={showFurigana}
                  title="Toggle furigana"
                  className="absolute top-2 right-2 h-8 gap-1 px-2 z-10"
                >
                  <Languages className="h-3.5 w-3.5" />
                  <span className="font-jp text-[11px]">あ</span>
                </Button>
                <div className="text-center px-6">
                  <Furigana text={reviewCard?.word ?? ""} show={showFurigana} className="font-jp text-3xl font-bold mb-3 inline-block" />
                  {reviewCard?.reading === reviewCard?.word && <div className="sr-only">{reviewCard?.reading}</div>}
                  <div className="text-lg font-semibold mb-3">{reviewCard?.meaning}</div>
                  <div className="text-xs text-muted-foreground italic">{reviewCard?.part_of_speech} • {reviewCard?.jlpt_level}</div>
                  {reviewCard?.example_sentence_jp && (
                    <div className="mt-4 text-xs">
                      <Furigana text={reviewCard.example_sentence_jp} show={showFurigana} className="font-jp text-sm leading-loose" />
                      <div className="text-muted-foreground mt-1">{reviewCard.example_sentence_en}</div>
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </div>

          <div className="flex justify-center mb-4">
            <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); reviewCard && speak(reviewCard.reading || reviewCard.word); }}>
              <Volume2 className="h-4 w-4" /> Play audio
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={onReviewLearning} className="h-12">
              <X className="h-4 w-4" /> Still learning
            </Button>
            <Button onClick={onReviewKnow} className="h-12 bg-success text-success-foreground hover:bg-success/90">
              <Check className="h-4 w-4" /> I know this
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="quiz">
          {quizVocab.length === 0 ? (
            <Card className="p-8 gradient-card border-border/50 text-center">
              <p className="text-sm text-muted-foreground">
                Nothing to quiz — you already know every word in this episode! 🎉
              </p>
            </Card>
          ) : (
            <>
              <Progress value={(quizIdx / quizVocab.length) * 100} className="h-2 mb-4" />
              <div className="text-xs text-muted-foreground text-center mb-4">{Math.min(quizIdx + 1, quizVocab.length)} / {quizVocab.length}</div>

              <Card className="p-6 gradient-card border-border/50 shadow-card mb-4 text-center">
                <div className="text-xs text-muted-foreground mb-2">What does this mean?</div>
                {(() => {
                  const showKanji = !quizCard ? false : (streaks[quizCard.word] ?? 0) >= KANJI_THRESHOLD || quizCard.word === quizCard.reading;
                  return (
                    <>
                      <div className="font-jp text-5xl font-bold mb-2">
                        {showKanji ? quizCard?.word : quizCard?.reading}
                      </div>
                      {showKanji
                        ? <div className="font-jp text-muted-foreground">{quizCard?.reading}</div>
                        : quizCard && quizCard.word !== quizCard.reading && <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Hiragana mode</div>}
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
              I don't know
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

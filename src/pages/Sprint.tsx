import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Check,
  Headphones,
  Library,
  RotateCcw,
  Sparkles,
  Type,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/i18n";
import { formatLevel } from "@/lib/languages";
import { useSrsDeck } from "@/lib/srs-store";
import {
  LEARN_BATCH_SIZE,
  nextIntervalDaysForGrade,
  pickContextualSentence,
  shouldShowReadingUpfront,
  SPRINT_LAPSE_REINSERT_GAP,
  SrsDeckCard,
  WordSrsRecord,
} from "@/lib/srs";
import { ContextSentence } from "@/components/ContextSentence";
import { cn } from "@/lib/utils";

const TTS_LANG: Record<string, string> = {
  ja: "ja-JP",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
};

interface UndoSnapshot {
  card: SrsDeckCard;
  prevRecord: WordSrsRecord;
  prevQueue: SrsDeckCard[];
  wasCorrect: boolean;
  prevLapsedWords: string[];
}

export default function Sprint() {
  const navigate = useNavigate();
  const { user, learningLanguage, learningLanguageInfo, progress } = useAuth();
  const { t } = useI18n();

  const {
    cards,
    dueCards,
    graduatedCards,
    dueWithin24hCount,
    nextEpisode,
    syncing,
    pendingSyncCount,
    gradeCard,
    restoreRecord,
  } = useSrsDeck(user?.id, learningLanguage, progress?.level);

  const [queue, setQueue] = useState<SrsDeckCard[]>([]);
  const [cramMode, setCramMode] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [readingPeeked, setReadingPeeked] = useState(false);
  const [listeningMode, setListeningMode] = useState(false);
  const [autoAudio, setAutoAudio] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [undoStack, setUndoStack] = useState<UndoSnapshot[]>([]);
  const sessionStartRef = useRef<number>(Date.now());
  const initializedForLangRef = useRef<string>("");
  const revealedRef = useRef<boolean>(false);
  const lapsedInSessionRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    revealedRef.current = revealed;
  }, [revealed]);

  // Seed, top up, and prune queue as dueCards sync without disrupting active card mid-reveal
  useEffect(() => {
    const key = `${user?.id ?? ""}:${learningLanguage}`;
    if (initializedForLangRef.current !== key) {
      initializedForLangRef.current = key;
      lapsedInSessionRef.current.clear();
      setQueue(dueCards);
      setCramMode(false);
      setRevealed(false);
      setReadingPeeked(false);
      setReviewedCount(0);
      setUndoStack([]);
      sessionStartRef.current = Date.now();
      return;
    }
    if (!cramMode) {
      const dueByWord = new Map(dueCards.map((c) => [c.word, c]));
      setQueue((prev) => {
        if (prev.length === 0) {
          return dueCards;
        }
        const kept = prev.filter((item, idx) => {
          if (idx === 0 && revealedRef.current) return true;
          if (dueByWord.has(item.word)) return true;
          const live = cards[item.word];
          if (lapsedInSessionRef.current.has(item.word) && live?.state === "learning") {
            return true;
          }
          return false;
        });
        const existingWords = new Set(kept.map((c) => c.word));
        const newlyDue = dueCards.filter((c) => !existingWords.has(c.word));
        if (kept.length === prev.length && newlyDue.length === 0) {
          return prev;
        }
        return [...kept, ...newlyDue];
      });
    }
  }, [dueCards, cards, user?.id, learningLanguage, cramMode]);

  const currentRaw = queue[0] ?? null;
  const current = currentRaw ? (cards[currentRaw.word] ?? currentRaw) : null;

  const activeContext = useMemo(() => {
    if (!current) return null;
    const seed = (current.srs_level ?? 0) + (current.correct_streak ?? 0) + reviewedCount;
    return pickContextualSentence(current.contexts, seed);
  }, [current, reviewedCount]);

  const speak = useCallback(
    (text: string) => {
      if (!("speechSynthesis" in window) || !text) return;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = TTS_LANG[learningLanguage] ?? "ja-JP";
        u.rate = 0.98;
        const voices = window.speechSynthesis.getVoices();
        const match = voices.find((v) => v.lang?.toLowerCase().startsWith(learningLanguage));
        if (match) u.voice = match;
        window.speechSynthesis.speak(u);
      } catch {
        // Ignore TTS unsupported errors
      }
    },
    [learningLanguage],
  );

  const currentWord = current?.word ?? null;
  const currentSpoken = current ? (current.reading || current.word) : "";

  useEffect(() => {
    setReadingPeeked(false);
  }, [currentWord, reviewedCount]);

  // In listening mode (explicitly toggled), play audio on prompt presentation
  useEffect(() => {
    if (!currentWord || revealed) return;
    if (listeningMode && currentSpoken) {
      speak(currentSpoken);
    }
  }, [currentWord, currentSpoken, revealed, listeningMode, speak]);

  const onReveal = useCallback(() => {
    if (!current || revealed) return;
    setRevealed(true);
    if (autoAudio) {
      speak(current.reading || current.word);
    }
  }, [current, revealed, autoAudio, speak]);

  const onGrade = useCallback(
    (remembered: boolean) => {
      if (!current) return;
      const snapshotQueue = queue;
      const prevLapsedWords = Array.from(lapsedInSessionRef.current);
      if (remembered) {
        lapsedInSessionRef.current.delete(current.word);
      } else {
        lapsedInSessionRef.current.add(current.word);
      }
      const prevRecord = gradeCard(current, remembered);

      setUndoStack((s) => [
        ...s.slice(-19),
        {
          card: current,
          prevRecord,
          prevQueue: snapshotQueue,
          wasCorrect: remembered,
          prevLapsedWords,
        },
      ]);
      setReviewedCount((c) => c + 1);
      setRevealed(false);
      setReadingPeeked(false);

      setQueue((prev) => {
        const [head, ...rest] = prev;
        if (!head) return prev;
        if (remembered) {
          return rest;
        }
        // Short-lag intraday re-insertion so missed cards are re-encoded before leaving Sprint
        const next = [...rest];
        const insertIdx = Math.min(SPRINT_LAPSE_REINSERT_GAP, next.length);
        next.splice(insertIdx, 0, head);
        return next;
      });
    },
    [current, queue, gradeCard],
  );

  const onUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const last = undoStack[undoStack.length - 1];
    lapsedInSessionRef.current = new Set(last.prevLapsedWords);
    setUndoStack((stack) => stack.slice(0, -1));
    restoreRecord(last.card, last.prevRecord);
    setQueue(last.prevQueue);
    setRevealed(false);
    setReadingPeeked(false);
    setReviewedCount((c) => Math.max(0, c - 1));
  }, [undoStack, restoreRecord]);

  const startPracticeAhead = () => {
    if (graduatedCards.length === 0) return;
    const sorted = [...graduatedCards].sort(
      (a, b) => new Date(a.srs_due_at ?? 0).getTime() - new Date(b.srs_due_at ?? 0).getTime(),
    );
    setCramMode(true);
    setQueue(sorted.slice(0, 25));
    setRevealed(false);
    setReadingPeeked(false);
  };

  const hasDistinctReading = Boolean(
    current &&
      learningLanguageInfo.hasRuby &&
      current.reading &&
      current.reading !== current.word,
  );
  const showReadingNow = Boolean(
    current &&
      hasDistinctReading &&
      (revealed || readingPeeked || shouldShowReadingUpfront(current)),
  );

  // Instant keyboard flow: R peeks reading, Space/Enter reveals, then 1/ArrowLeft = Again, 2/ArrowRight/Space = Know, Z = Undo
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey || !current)) {
        e.preventDefault();
        onUndo();
        return;
      }
      if (!current) return;
      if (!revealed) {
        if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey && !e.altKey && hasDistinctReading) {
          e.preventDefault();
          setReadingPeeked(true);
        } else if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onReveal();
        }
      } else {
        if (e.key === "1" || e.key === "ArrowLeft") {
          e.preventDefault();
          onGrade(false);
        } else if (e.key === "2" || e.key === "ArrowRight" || e.key === " ") {
          e.preventDefault();
          onGrade(true);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current, revealed, hasDistinctReading, onReveal, onGrade, onUndo]);

  const cardsPerMin = useMemo(() => {
    if (reviewedCount < 2) return 0;
    const elapsedMin = Math.max(0.15, (Date.now() - sessionStartRef.current) / 60000);
    return Math.min(99, Math.round(reviewedCount / elapsedMin));
  }, [reviewedCount]);

  const nextKnowDays = useMemo(
    () => (current ? nextIntervalDaysForGrade(current, true, Date.now()) : 1),
    [current],
  );

  const batchCount = nextEpisode ? Math.min(LEARN_BATCH_SIZE, nextEpisode.unlearnedCount) : 0;

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground select-none">
      {/* Minimal Top Bar — Zero Distraction */}
      <header className="w-full max-w-xl mx-auto px-4 pt-3 pb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div
            id="sprint-due-pill"
            className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-xs font-semibold tracking-tight"
          >
            <Zap className="h-3.5 w-3.5 text-primary" />
            <span>{t("sprint.dueBadge", { n: queue.length })}</span>
          </div>
          {cardsPerMin > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">
              {t("sprint.rate", { n: cardsPerMin })}
            </span>
          )}
          {pendingSyncCount > 0 && (
            <span className="text-[11px] text-muted-foreground">· {t("sprint.syncing")}</span>
          )}
          {undoStack.length > 0 && (
            <Button
              id="sprint-undo-button"
              variant="ghost"
              size="sm"
              onClick={onUndo}
              title={t("sprint.undo")}
              className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="sr-only">{t("sprint.undo")}</span>
            </Button>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button
            id="sprint-mode-toggle"
            variant={listeningMode ? "secondary" : "ghost"}
            size="icon"
            className="h-8 w-8"
            onClick={() => setListeningMode((v) => !v)}
            title={listeningMode ? t("sprint.listeningMode") : t("sprint.readingMode")}
          >
            {listeningMode ? <Headphones className="h-4 w-4 text-primary" /> : <Type className="h-4 w-4" />}
          </Button>
          <Button
            id="sprint-audio-toggle"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setAutoAudio((v) => !v)}
            title={t("sprint.autoAudio")}
          >
            {autoAudio ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4 text-muted-foreground" />}
          </Button>
          <Button
            id="sprint-open-library"
            variant="outline"
            size="sm"
            onClick={() => navigate("/library")}
            className="h-8 gap-1.5 px-3 text-xs font-medium border-border/80 bg-card/60"
          >
            <Library className="h-3.5 w-3.5" />
            <span>{t("sprint.library")}</span>
          </Button>
        </div>
      </header>

      {/* Main Stage */}
      {current ? (
        <main className="flex-1 w-full max-w-xl mx-auto px-4 pb-6 pt-2 flex flex-col justify-between gap-4">
          <h1 className="sr-only">{t("nav.sprint")}</h1>

          {/* Card Surface — Tap anywhere on card when unrevealed */}
          <section
            id="sprint-card-surface"
            onClick={() => { if (!revealed) onReveal(); }}
            className={cn(
              "flex-1 rounded-2xl gradient-card border border-border/70 shadow-card px-6 py-7 flex flex-col justify-between transition-colors",
              !revealed && "cursor-pointer active:bg-secondary/40",
            )}
          >
            {/* Card Metadata Row */}
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2 min-w-0 truncate">
                {current.level && (
                  <Badge variant="secondary" className="text-[10px] font-medium px-2 py-0">
                    {formatLevel(current.level)}
                  </Badge>
                )}
                {activeContext?.animeTitle && activeContext?.episodeNumber && (
                  <span className="truncate">
                    {t("sprint.EpisodeTag", {
                      title: activeContext.animeTitle,
                      ep: activeContext.episodeNumber,
                    })}
                  </span>
                )}
              </div>
              <button
                type="button"
                id="sprint-replay-audio"
                onClick={(e) => {
                  e.stopPropagation();
                  speak(current.reading || current.word);
                }}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-secondary/60"
              >
                <Volume2 className="h-3.5 w-3.5" />
                <span>{t("sprint.replayAudio")}</span>
              </button>
            </div>

            {/* Center Prompt + Reveal Block */}
            <div className="my-auto py-4 text-center space-y-5">
              {listeningMode && !revealed ? (
                <div className="py-6 space-y-3">
                  <div className="mx-auto h-16 w-16 rounded-full bg-primary/15 border border-primary/30 grid place-items-center">
                    <Headphones className="h-7 w-7 text-primary" />
                  </div>
                  <p className="text-sm text-muted-foreground">{t("sprint.listenPrompt")}</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {showReadingNow ? (
                    <div className="font-jp text-lg text-primary font-medium tracking-wide">
                      {current.reading}
                    </div>
                  ) : (
                    !revealed &&
                    hasDistinctReading && (
                      <div className="pb-1">
                        <button
                          type="button"
                          id="sprint-peek-reading"
                          onClick={(e) => {
                            e.stopPropagation();
                            setReadingPeeked(true);
                          }}
                          title={t("sprint.peekReadingHint")}
                          className="inline-flex items-center gap-1 rounded-full bg-secondary/80 hover:bg-secondary border border-border/70 px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <span className="font-jp">{t("sprint.peekReading")}</span>
                        </button>
                      </div>
                    )
                  )}
                  <div
                    className={cn(
                      "text-5xl sm:text-6xl font-bold tracking-tight break-words",
                      learningLanguageInfo.hasRuby && "font-jp",
                    )}
                  >
                    {current.word}
                  </div>
                </div>
              )}

              {/* Contextual Sentence from Unlocked Anime Episode */}
              {activeContext && (!listeningMode || revealed) && (
                <div className="max-w-md mx-auto rounded-xl bg-background/55 border border-border/50 px-4 py-3 text-left space-y-1.5">
                  <ContextSentence
                    sentence={activeContext.jp}
                    targetWord={current.word}
                    showFurigana={revealed || showReadingNow}
                    hasRuby={learningLanguageInfo.hasRuby}
                    className="text-base sm:text-lg text-foreground/95"
                  />
                  {revealed && activeContext.en && (
                    <p className="text-xs sm:text-sm text-muted-foreground leading-snug">
                      {activeContext.en}
                    </p>
                  )}
                </div>
              )}

              {/* Meaning Reveal */}
              {revealed && (
                <div className="pt-2 space-y-1 animate-in fade-in duration-100">
                  <div className="text-2xl sm:text-3xl font-semibold text-foreground break-words">
                    {current.meaning}
                  </div>
                  {current.part_of_speech && (
                    <div className="text-xs text-muted-foreground">{current.part_of_speech}</div>
                  )}
                </div>
              )}
            </div>

            <div className="h-4 text-center text-[11px] text-muted-foreground/70">
              {!revealed ? t("sprint.tapToReveal") : ""}
            </div>
          </section>

          {/* Ergonomic Thumb Action Bar */}
          <div className="w-full">
            {!revealed ? (
              <Button
                id="sprint-reveal-button"
                onClick={onReveal}
                className="w-full h-16 rounded-xl text-base font-semibold bg-secondary hover:bg-secondary/80 text-foreground border border-border/80"
              >
                {t("sprint.tapToReveal")}
              </Button>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Button
                  id="sprint-grade-again"
                  variant="outline"
                  onClick={() => onGrade(false)}
                  className="h-16 rounded-xl flex flex-col items-center justify-center gap-0.5 border-destructive/40 hover:bg-destructive/15 hover:border-destructive/60"
                >
                  <span className="inline-flex items-center gap-1.5 text-base font-semibold text-destructive">
                    <X className="h-4 w-4" />
                    {t("sprint.again")}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{t("sprint.againSub")}</span>
                </Button>

                <Button
                  id="sprint-grade-know"
                  onClick={() => onGrade(true)}
                  className="h-16 rounded-xl flex flex-col items-center justify-center gap-0.5 bg-success hover:bg-success/90 text-success-foreground"
                >
                  <span className="inline-flex items-center gap-1.5 text-base font-semibold">
                    <Check className="h-4 w-4" />
                    {t("sprint.know")}
                  </span>
                  <span className="text-[11px] text-success-foreground/85">
                    {t("sprint.knowSub", { days: nextKnowDays })}
                  </span>
                </Button>
              </div>
            )}
          </div>
        </main>
      ) : (
        /* Caught-Up / Ready State */
        <main className="flex-1 w-full max-w-md mx-auto px-5 pb-10 flex flex-col justify-center">
          <div className="rounded-2xl gradient-card border border-border/70 shadow-card p-6 space-y-6">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 text-xs font-medium text-success">
                <Check className="h-4 w-4" />
                <span>{syncing ? t("sprint.syncing") : t("sprint.caughtUpTitle")}</span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight">{t("sprint.caughtUpTitle")}</h1>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {t("sprint.caughtUpBody")}
              </p>
            </div>

            {/* Compact SRS Velocity Metrics */}
            <div className="grid grid-cols-3 gap-2 pt-1">
              <div className="rounded-xl bg-background/60 border border-border/50 px-3 py-2.5">
                <div className="text-lg font-bold tabular-nums">{reviewedCount}</div>
                <div className="text-[11px] text-muted-foreground">
                  {t("sprint.completedToday", { n: reviewedCount })}
                </div>
              </div>
              <div className="rounded-xl bg-background/60 border border-border/50 px-3 py-2.5">
                <div className="text-lg font-bold tabular-nums">{graduatedCards.length}</div>
                <div className="text-[11px] text-muted-foreground">
                  {t("sprint.activeDeck", { n: graduatedCards.length })}
                </div>
              </div>
              <div className="rounded-xl bg-background/60 border border-border/50 px-3 py-2.5">
                <div className="text-lg font-bold tabular-nums">{dueWithin24hCount}</div>
                <div className="text-[11px] text-muted-foreground">
                  {t("sprint.dueSoon", { n: dueWithin24hCount })}
                </div>
              </div>
            </div>

            {/* Direct Actions: Contextual Learn Batch vs Practice Ahead vs Library */}
            <div className="grid gap-2.5">
              {nextEpisode && batchCount > 0 ? (
                <Button
                  id="sprint-learn-next-cta"
                  onClick={() => navigate(`/learn/${nextEpisode.episodeId}`)}
                  className="w-full h-14 py-3.5 gradient-primary text-primary-foreground font-semibold rounded-xl shadow-elegant"
                >
                  <Sparkles className="h-4 w-4" />
                  <span className="truncate">
                    {t("sprint.learnNextCta", {
                      n: batchCount,
                      title: nextEpisode.animeTitle,
                      ep: nextEpisode.episodeNumber,
                    })}
                  </span>
                </Button>
              ) : (
                <Button
                  id="sprint-open-library-primary"
                  onClick={() => navigate("/library")}
                  className="w-full h-12 gradient-primary text-primary-foreground font-semibold rounded-xl"
                >
                  <Library className="h-4 w-4" />
                  {t("sprint.openLibrary")}
                </Button>
              )}

              {graduatedCards.length > 0 && (
                <Button
                  id="sprint-practice-ahead"
                  variant="secondary"
                  onClick={startPracticeAhead}
                  className="w-full h-11 rounded-xl font-medium"
                >
                  {t("sprint.practiceAhead", { n: Math.min(25, graduatedCards.length) })}
                </Button>
              )}

              {nextEpisode && batchCount > 0 && (
                <Button
                  id="sprint-open-library-secondary"
                  variant="ghost"
                  onClick={() => navigate("/library")}
                  className="w-full h-10 text-muted-foreground hover:text-foreground"
                >
                  <Library className="h-4 w-4" />
                  {t("sprint.openLibrary")}
                </Button>
              )}
            </div>
          </div>
        </main>
      )}
    </div>
  );
}

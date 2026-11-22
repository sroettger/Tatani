import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  FastForward,
  Library,
  Loader2,
  Sparkles,
  Volume2,
  X,
  Zap,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/i18n";
import { formatLevel, levelRank } from "@/lib/languages";
import {
  extractKanjiCharacters,
  isUnlearnedCandidate,
  LEARN_BATCH_SIZE,
  LEARN_GRADUATION_RECALLS,
  pickContextualSentence,
  SrsDeckCard,
} from "@/lib/srs";
import { useSrsDeck } from "@/lib/srs-store";
import { ContextSentence } from "@/components/ContextSentence";
import { cn } from "@/lib/utils";

const TTS_LANG: Record<string, string> = {
  ja: "ja-JP",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
};

type RawVocab = {
  word: string;
  reading?: string;
  meaning?: string;
  part_of_speech?: string;
  jlpt_level?: string;
  level?: string;
  example_sentence_jp?: string;
  example_sentence_en?: string;
  frequency?: number;
};

type Phase = "encode" | "drill" | "done";

export default function LearnSession() {
  const { episodeId } = useParams();
  const navigate = useNavigate();
  const { user, learningLanguage, learningLanguageInfo, progress } = useAuth();
  const { t } = useI18n();

  const {
    cards,
    nextEpisode,
    syncing,
    gradeCard,
    markPriorKnown,
  } = useSrsDeck(user?.id, learningLanguage, progress?.level);

  const [episodePool, setEpisodePool] = useState<SrsDeckCard[] | null>(null);
  const [loadingEpisode, setLoadingEpisode] = useState(Boolean(episodeId));
  const [phase, setPhase] = useState<Phase>("encode");
  const [batch, setBatch] = useState<SrsDeckCard[]>([]);
  const [encodeIdx, setEncodeIdx] = useState(0);
  const [drillQueue, setDrillQueue] = useState<SrsDeckCard[]>([]);
  const [drillRevealed, setDrillRevealed] = useState(false);
  const [drillReadingPeeked, setDrillReadingPeeked] = useState(false);
  const [drillHits, setDrillHits] = useState<Record<string, number>>({});
  const [graduatedCount, setGraduatedCount] = useState(0);

  const cardsRef = useRef(cards);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  const loadedPoolKeyRef = useRef<string>("");
  const targetEpisodeId = episodeId ?? nextEpisode?.episodeId ?? null;
  const userId = user?.id;

  // Load raw episode vocab pool once per (userId, targetEpisodeId, learningLanguage) without re-fetching on card mutations
  useEffect(() => {
    if (!userId || !targetEpisodeId) {
      loadedPoolKeyRef.current = "";
      setEpisodePool(null);
      setLoadingEpisode(false);
      return;
    }

    const poolKey = `${userId}:${targetEpisodeId}:${learningLanguage}`;
    if (loadedPoolKeyRef.current === poolKey) {
      return;
    }

    if (nextEpisode && nextEpisode.episodeId === targetEpisodeId && nextEpisode.words.length > 0) {
      loadedPoolKeyRef.current = poolKey;
      setEpisodePool(nextEpisode.words);
      setLoadingEpisode(false);
      return;
    }

    let cancelled = false;
    (async () => {
      setLoadingEpisode(true);
      const [{ data: ep }, { data: cache }] = await Promise.all([
        supabase
          .from("episodes")
          .select("id, episode_number, seasons(anime(title_en,title_romaji))")
          .eq("id", targetEpisodeId)
          .maybeSingle(),
        supabase
          .from("episode_vocab_cache")
          .select("vocab")
          .eq("episode_id", targetEpisodeId)
          .eq("language", learningLanguage)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      type EpisodeWithAnime = {
        episode_number?: number;
        seasons?: { anime?: { title_en?: string | null; title_romaji?: string | null } | null } | null;
      };
      const typedEp = ep as EpisodeWithAnime | null;
      const animeMeta = typedEp?.seasons?.anime;
      const animeTitle = animeMeta?.title_en ?? animeMeta?.title_romaji ?? "";
      const epNumber = typedEp?.episode_number ?? 1;
      const rawList = ((cache?.vocab ?? []) as RawVocab[]);
      const snapshotCards = cardsRef.current;

      const list: SrsDeckCard[] = [];
      for (const v of rawList) {
        if (!v.word || !v.meaning) continue;
        const lvl = v.level ?? v.jlpt_level ?? null;
        const existing = snapshotCards[v.word];
        list.push({
          word: v.word,
          reading: v.reading ?? existing?.reading ?? null,
          meaning: v.meaning,
          part_of_speech: v.part_of_speech ?? existing?.part_of_speech ?? "",
          level: lvl === "none" ? null : lvl,
          frequency: v.frequency ?? existing?.frequency ?? 1,
          state: existing?.state ?? "unknown",
          preference: existing?.preference ?? "study",
          known_source: existing?.known_source ?? null,
          correct_streak: existing?.correct_streak ?? 0,
          srs_level: existing?.srs_level ?? 0,
          srs_due_at: existing?.srs_due_at ?? null,
          last_reviewed_at: existing?.last_reviewed_at ?? null,
          contexts: v.example_sentence_jp
            ? [
                {
                  jp: v.example_sentence_jp,
                  en: v.example_sentence_en ?? "",
                  animeTitle,
                  episodeNumber: epNumber,
                  episodeId: targetEpisodeId,
                },
              ]
            : existing?.contexts ?? [],
        });
      }

      list.sort((a, b) => {
        const rA = levelRank(learningLanguage, a.level ?? "none") || 6;
        const rB = levelRank(learningLanguage, b.level ?? "none") || 6;
        return b.frequency * 10 + Math.max(0, 6 - rB) - (a.frequency * 10 + Math.max(0, 6 - rA));
      });
      loadedPoolKeyRef.current = poolKey;
      setEpisodePool(list);
      setLoadingEpisode(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, targetEpisodeId, nextEpisode, learningLanguage]);

  const availableUnlearned = useMemo(() => {
    const source = episodePool ?? nextEpisode?.words ?? [];
    const myRank = levelRank(learningLanguage, progress?.level);
    const isBelowLevel = (lvl: string | null | undefined) =>
      myRank > 0 && (levelRank(learningLanguage, lvl ?? "none") || 99) < myRank;
    return source.filter((item) => isUnlearnedCandidate(cards[item.word] ?? item, isBelowLevel(item.level)));
  }, [episodePool, nextEpisode, cards, learningLanguage, progress?.level]);

  // Seed batch when entering encode phase
  useEffect(() => {
    if (batch.length === 0 && availableUnlearned.length > 0 && phase === "encode") {
      setBatch(availableUnlearned.slice(0, LEARN_BATCH_SIZE));
      setEncodeIdx(0);
    }
  }, [availableUnlearned, batch.length, phase]);

  const speak = useCallback(
    (text: string) => {
      if (!("speechSynthesis" in window) || !text) return;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = TTS_LANG[learningLanguage] ?? "ja-JP";
        u.rate = 0.95;
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

  const encodeCard = batch[encodeIdx] ?? null;
  const drillCard = drillQueue[0] ?? null;
  const activeCard = phase === "encode" ? encodeCard : phase === "drill" ? drillCard : null;
  const activeContext = useMemo(
    () => (activeCard ? pickContextualSentence(activeCard.contexts, 0) : null),
    [activeCard],
  );

  const beginDrill = useCallback((encodedBatch: SrsDeckCard[]) => {
    if (encodedBatch.length === 0) {
      setPhase("done");
      return;
    }
    setPhase("drill");
    setDrillQueue([...encodedBatch]);
    setDrillHits({});
    setDrillRevealed(false);
    setDrillReadingPeeked(false);
    setGraduatedCount(0);
  }, []);

  const onAlreadyKnow = useCallback(() => {
    if (!encodeCard) return;
    markPriorKnown(encodeCard);
    const batchWords = new Set(batch.map((b) => b.word));
    const replacement = availableUnlearned.find(
      (c) => c.word !== encodeCard.word && !batchWords.has(c.word),
    );
    const updatedBatch = batch.filter((b) => b.word !== encodeCard.word);
    if (replacement) {
      updatedBatch.splice(encodeIdx, 0, replacement);
      setBatch(updatedBatch);
    } else {
      setBatch(updatedBatch);
      if (encodeIdx >= updatedBatch.length) {
        beginDrill(updatedBatch);
      }
    }
  }, [encodeCard, markPriorKnown, batch, availableUnlearned, encodeIdx, beginDrill]);

  const onGotItEncode = useCallback(() => {
    if (!encodeCard) return;
    if (encodeIdx + 1 < batch.length) {
      setEncodeIdx(encodeIdx + 1);
    } else {
      beginDrill(batch);
    }
  }, [encodeCard, encodeIdx, batch, beginDrill]);

  const onRevealDrill = useCallback(() => {
    if (!drillCard || drillRevealed) return;
    setDrillRevealed(true);
  }, [drillCard, drillRevealed]);

  const onGradeDrill = useCallback(
    (recalled: boolean) => {
      if (!drillCard) return;
      const prevHits = drillHits[drillCard.word] ?? 0;
      const nextHits = recalled ? prevHits + 1 : 0;
      setDrillHits((h) => ({ ...h, [drillCard.word]: nextHits }));
      setDrillRevealed(false);
      setDrillReadingPeeked(false);

      const [head, ...rest] = drillQueue;
      if (!head) return;

      if (recalled && nextHits >= LEARN_GRADUATION_RECALLS) {
        // Graduate word into SRS!
        gradeCard(head, true);
        const nextGrad = graduatedCount + 1;
        setGraduatedCount(nextGrad);
        if (rest.length === 0) {
          // Record completed study session asynchronously
          if (user && targetEpisodeId) {
            void supabase.from("study_sessions").insert({
              user_id: user.id,
              episode_id: targetEpisodeId,
              mode: "learn_context",
              words_studied: batch.length,
              words_mastered: nextGrad,
              learning_language: learningLanguage,
              finished_at: new Date().toISOString(),
            });
          }
          setPhase("done");
        }
        setDrillQueue(rest);
        return;
      }

      // Expanding short-lag re-insertion within the micro-batch (Nakata, 2015)
      const gap = recalled ? Math.min(3, rest.length) : Math.min(2, rest.length);
      const nextQueue = [...rest];
      nextQueue.splice(Math.max(rest.length > 0 ? 1 : 0, gap), 0, head);
      setDrillQueue(nextQueue);
    },
    [drillCard, drillHits, drillQueue, gradeCard, graduatedCount, user, targetEpisodeId, batch.length, learningLanguage],
  );

  const startNextBatch = () => {
    setBatch([]);
    setEncodeIdx(0);
    setDrillQueue([]);
    setDrillHits({});
    setDrillRevealed(false);
    setDrillReadingPeeked(false);
    setGraduatedCount(0);
    setPhase("encode");
  };

  const currentDrillHits = drillCard ? (drillHits[drillCard.word] ?? 0) : 0;
  const hasDistinctDrillReading = Boolean(
    drillCard &&
      learningLanguageInfo.hasRuby &&
      drillCard.reading &&
      drillCard.reading !== drillCard.word,
  );
  const showDrillReading = Boolean(
    hasDistinctDrillReading && (drillRevealed || drillReadingPeeked || currentDrillHits === 0),
  );

  // Keyboard shortcuts for blazingly fast desktop/hardware-keyboard flow
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (phase === "encode" && encodeCard) {
        if (e.key === " " || e.key === "Enter" || e.key === "ArrowRight") {
          e.preventDefault();
          onGotItEncode();
        } else if (e.key === "k" || e.key === "K") {
          e.preventDefault();
          onAlreadyKnow();
        }
      } else if (phase === "drill" && drillCard) {
        if (!drillRevealed) {
          if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey && !e.altKey && hasDistinctDrillReading) {
            e.preventDefault();
            setDrillReadingPeeked(true);
          } else if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            onRevealDrill();
          }
        } else if (drillRevealed) {
          if (e.key === "1" || e.key === "ArrowLeft") {
            e.preventDefault();
            onGradeDrill(false);
          } else if (e.key === "2" || e.key === "ArrowRight" || e.key === " ") {
            e.preventDefault();
            onGradeDrill(true);
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, encodeCard, drillCard, drillRevealed, hasDistinctDrillReading, onGotItEncode, onAlreadyKnow, onRevealDrill, onGradeDrill]);

  if (loadingEpisode || (syncing && batch.length === 0 && availableUnlearned.length === 0)) {
    return (
      <div className="min-h-[100dvh] grid place-items-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (batch.length === 0 && phase !== "done") {
    return (
      <div className="min-h-[100dvh] flex flex-col justify-center max-w-md mx-auto px-5 bg-background">
        <div className="rounded-2xl gradient-card border border-border/70 shadow-card p-6 text-center space-y-4">
          <Sparkles className="h-8 w-8 text-primary mx-auto" />
          <h1 className="text-xl font-bold">{t("learn.emptyTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("learn.emptyBody")}</p>
          <div className="grid gap-2 pt-2">
            <Button onClick={() => navigate("/library")} className="h-12 gradient-primary text-primary-foreground rounded-xl">
              <Library className="h-4 w-4" />
              {t("sprint.openLibrary")}
            </Button>
            <Button variant="ghost" onClick={() => navigate("/")}>
              {t("learn.goToSprint")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "done") {
    const remainingNext = Math.min(LEARN_BATCH_SIZE, availableUnlearned.length);
    return (
      <div className="min-h-[100dvh] flex flex-col justify-center max-w-md mx-auto px-5 bg-background">
        <div className="rounded-2xl gradient-card border border-border/70 shadow-card p-6 space-y-5 text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-success/15 border border-success/40 grid place-items-center">
            <Check className="h-6 w-6 text-success" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-2xl font-bold">{t("learn.graduatedTitle")}</h1>
            <p className="text-sm text-muted-foreground">
              {t("learn.graduatedBody", { n: graduatedCount })}
            </p>
          </div>
          <div className="grid gap-2.5 pt-2">
            {remainingNext > 0 && (
              <Button
                id="learn-next-batch-button"
                onClick={startNextBatch}
                className="h-12 rounded-xl gradient-primary text-primary-foreground font-semibold"
              >
                <Sparkles className="h-4 w-4" />
                {t("learn.nextBatch", { n: remainingNext })}
              </Button>
            )}
            <Button
              id="learn-back-to-sprint"
              variant={remainingNext > 0 ? "secondary" : "default"}
              onClick={() => navigate("/")}
              className="h-12 rounded-xl font-semibold"
            >
              <Zap className="h-4 w-4" />
              {t("learn.goToSprint")}
            </Button>
            {targetEpisodeId && (
              <Button variant="ghost" onClick={() => navigate(`/episode/${targetEpisodeId}`)}>
                {t("study.backToEpisode")}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const totalProgress =
    phase === "encode"
      ? Math.round((encodeIdx / Math.max(1, batch.length * 2)) * 100)
      : 50 + Math.round((graduatedCount / Math.max(1, batch.length)) * 50);

  const kanjiChars =
    learningLanguageInfo.hasRuby && encodeCard ? extractKanjiCharacters(encodeCard.word) : [];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground select-none">
      {/* Top Bar */}
      <header className="w-full max-w-xl mx-auto px-4 pt-3 pb-2 space-y-2">
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(-1)}>
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <span className="text-xs font-medium text-muted-foreground">
            {phase === "encode"
              ? t("learn.stepEncode")
              : t("learn.stepDrill", { done: graduatedCount, total: batch.length })}
          </span>
          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => navigate("/")}>
            <Zap className="h-3.5 w-3.5 text-primary" />
            <span>{t("nav.sprint")}</span>
          </Button>
        </div>
        <Progress value={totalProgress} className="h-1.5" />
      </header>

      {phase === "encode" && encodeCard && (
        <main className="flex-1 w-full max-w-xl mx-auto px-4 pb-6 pt-1 flex flex-col justify-between gap-4">
          <h1 className="sr-only">{t("learn.title")}</h1>

          <section className="flex-1 rounded-2xl gradient-card border border-border/70 shadow-card px-6 py-6 flex flex-col justify-between gap-5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {encodeIdx + 1} / {batch.length}
              </span>
              <div className="flex items-center gap-2">
                {encodeCard.level && (
                  <Badge variant="secondary" className="text-[10px]">
                    {formatLevel(encodeCard.level)}
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={() => speak(encodeCard.reading || encodeCard.word)}
                  className="inline-flex items-center gap-1 hover:text-foreground px-2 py-1 rounded-md hover:bg-secondary/60"
                >
                  <Volume2 className="h-3.5 w-3.5" />
                  <span>{t("sprint.replayAudio")}</span>
                </button>
              </div>
            </div>

            {/* Word + Reading + Meaning Together (Guided Errorless Encoding!) */}
            <div className="text-center space-y-2">
              {learningLanguageInfo.hasRuby &&
                encodeCard.reading &&
                encodeCard.reading !== encodeCard.word && (
                  <div className="font-jp text-xl text-primary font-medium">
                    {encodeCard.reading}
                  </div>
                )}
              <div
                className={cn(
                  "text-5xl font-bold tracking-tight",
                  learningLanguageInfo.hasRuby && "font-jp",
                )}
              >
                {encodeCard.word}
              </div>
              <div className="text-2xl font-semibold pt-1">{encodeCard.meaning}</div>
              {encodeCard.part_of_speech && (
                <div className="text-xs text-muted-foreground">{encodeCard.part_of_speech}</div>
              )}

              {/* Kanji Morphological Breakdown Chips (Mori, 2003) */}
              {kanjiChars.length > 1 && (
                <div className="pt-2 flex items-center justify-center gap-1.5 flex-wrap">
                  <span className="text-[11px] text-muted-foreground mr-1">
                    {t("learn.kanjiParts")}:
                  </span>
                  {kanjiChars.map((ch) => (
                    <span
                      key={ch}
                      className="font-jp text-sm px-2.5 py-0.5 rounded-md bg-secondary border border-border/70 font-medium"
                    >
                      {ch}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Scene Dialogue Context First-Class */}
            {activeContext ? (
              <div className="rounded-xl bg-background/60 border border-border/60 p-4 space-y-2">
                {activeContext.animeTitle && activeContext.episodeNumber && (
                  <div className="text-[11px] text-muted-foreground font-medium">
                    {t("sprint.EpisodeTag", {
                      title: activeContext.animeTitle,
                      ep: activeContext.episodeNumber,
                    })}
                  </div>
                )}
                <ContextSentence
                  sentence={activeContext.jp}
                  targetWord={encodeCard.word}
                  showFurigana={true}
                  hasRuby={learningLanguageInfo.hasRuby}
                  className="text-base sm:text-lg"
                />
                {activeContext.en && (
                  <p className="text-xs sm:text-sm text-muted-foreground leading-snug">
                    {activeContext.en}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-center text-muted-foreground">{t("learn.encodeHint")}</p>
            )}
          </section>

          {/* Bottom Actions: Already Know (Triage out) vs Got It */}
          <div className="grid grid-cols-5 gap-2.5">
            <Button
              id="learn-already-know"
              variant="outline"
              onClick={onAlreadyKnow}
              className="col-span-2 h-14 py-3 rounded-xl flex flex-col items-center justify-center gap-0.5"
            >
              <span className="inline-flex items-center gap-1 text-sm font-medium">
                <FastForward className="h-3.5 w-3.5" />
                {t("learn.alreadyKnow")}
              </span>
              <span className="text-[10px] text-muted-foreground">{t("learn.alreadyKnowSub")}</span>
            </Button>

            <Button
              id="learn-got-it"
              onClick={onGotItEncode}
              className="col-span-3 h-14 py-3 rounded-xl gradient-primary text-primary-foreground font-semibold text-base"
            >
              <span>
                {encodeIdx + 1 < batch.length ? t("learn.gotIt") : t("learn.startDrill")}
              </span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </main>
      )}

      {phase === "drill" && drillCard && (
        <main className="flex-1 w-full max-w-xl mx-auto px-4 pb-6 pt-1 flex flex-col justify-between gap-4">
          <section
            onClick={() => { if (!drillRevealed) onRevealDrill(); }}
            className={cn(
              "flex-1 rounded-2xl gradient-card border border-border/70 shadow-card px-6 py-7 flex flex-col justify-between",
              !drillRevealed && "cursor-pointer active:bg-secondary/40",
            )}
          >
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t("learn.drillPrompt")}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  speak(drillCard.reading || drillCard.word);
                }}
                className="inline-flex items-center gap-1 hover:text-foreground px-2 py-1 rounded-md hover:bg-secondary/60"
              >
                <Volume2 className="h-3.5 w-3.5" />
                <span>{t("sprint.replayAudio")}</span>
              </button>
            </div>

            <div className="my-auto py-4 text-center space-y-5">
              <div className="space-y-1.5">
                {showDrillReading ? (
                  <div className="font-jp text-lg text-primary font-medium">
                    {drillCard.reading}
                  </div>
                ) : (
                  !drillRevealed &&
                  hasDistinctDrillReading && (
                    <div className="pb-1">
                      <button
                        type="button"
                        id="learn-drill-peek-reading"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDrillReadingPeeked(true);
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
                    "text-5xl font-bold tracking-tight",
                    learningLanguageInfo.hasRuby && "font-jp",
                  )}
                >
                  {drillCard.word}
                </div>
              </div>

              {activeContext && (
                <div className="max-w-md mx-auto rounded-xl bg-background/55 border border-border/50 px-4 py-3 text-left space-y-1.5">
                  <ContextSentence
                    sentence={activeContext.jp}
                    targetWord={drillCard.word}
                    showFurigana={drillRevealed || showDrillReading}
                    hasRuby={learningLanguageInfo.hasRuby}
                    className="text-base sm:text-lg"
                  />
                  {drillRevealed && activeContext.en && (
                    <p className="text-xs sm:text-sm text-muted-foreground">{activeContext.en}</p>
                  )}
                </div>
              )}

              {drillRevealed && (
                <div className="pt-2 space-y-1 animate-in fade-in duration-100">
                  <div className="text-2xl font-semibold">{drillCard.meaning}</div>
                  {drillCard.part_of_speech && (
                    <div className="text-xs text-muted-foreground">{drillCard.part_of_speech}</div>
                  )}
                </div>
              )}
            </div>

            <div className="h-4 text-center text-[11px] text-muted-foreground/70">
              {!drillRevealed ? t("sprint.tapToReveal") : ""}
            </div>
          </section>

          {!drillRevealed ? (
            <Button
              id="learn-drill-reveal"
              onClick={onRevealDrill}
              className="w-full h-16 rounded-xl text-base font-semibold bg-secondary hover:bg-secondary/80 text-foreground border border-border/80"
            >
              {t("sprint.tapToReveal")}
            </Button>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Button
                id="learn-drill-again"
                variant="outline"
                onClick={() => onGradeDrill(false)}
                className="h-16 rounded-xl font-semibold border-destructive/40 text-destructive hover:bg-destructive/15"
              >
                <X className="h-4 w-4" />
                {t("learn.needAnotherLook")}
              </Button>
              <Button
                id="learn-drill-know"
                onClick={() => onGradeDrill(true)}
                className="h-16 rounded-xl font-semibold bg-success hover:bg-success/90 text-success-foreground"
              >
                <Check className="h-4 w-4" />
                {t("learn.recalled", {
                  hits: (drillHits[drillCard.word] ?? 0) + 1,
                  req: LEARN_GRADUATION_RECALLS,
                })}
              </Button>
            </div>
          )}
        </main>
      )}
    </div>
  );
}

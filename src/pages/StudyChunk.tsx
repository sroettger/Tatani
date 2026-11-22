import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ChevronLeft, ChevronRight, Volume2, Check, X, Loader2, Languages } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { TutorChat } from "@/components/TutorChat";
import { Furigana } from "@/components/Furigana";
import { useI18n } from "@/i18n";
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

type ChunkWord = {
  word: string;
  reading: string | null;
  meaning: string | null;
  level: string | null;
  part_of_speech: string | null;
  example_sentence_jp: string | null;
  example_sentence_en: string | null;
};

type EpisodeVocabWord = {
  word: string;
  reading?: string | null;
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
const REQUIRED_KNOWN = 2;

export default function StudyChunk() {
  const { chunkId } = useParams();
  const navigate = useNavigate();
  const { user, learningLanguage, learningLanguageInfo } = useAuth();
  const { t } = useI18n();

  const [loading, setLoading] = useState(true);
  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [chunkIndex, setChunkIndex] = useState<number>(0);
  const [allWords, setAllWords] = useState<ChunkWord[]>([]);
  const [queue, setQueue] = useState<ChunkWord[]>([]);
  const [current, setCurrent] = useState<ChunkWord | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [sessionStreak, setSessionStreak] = useState<Record<string, number>>({});
  const [persistStreak, setPersistStreak] = useState<Record<string, number>>({});
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [doneCount, setDoneCount] = useState(0);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const [history, setHistory] = useState<ChunkWord[][]>([]);
  const [showFurigana, setShowFurigana] = useState(false);
  const wordRecordsRef = useRef<Record<string, WordSrsRecord>>({});

  const userId = user?.id;

  useEffect(() => {
    if (!chunkId || !userId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [{ data: chunk }, { data: words }] = await Promise.all([
        supabase.from("study_chunks").select("id,episode_id,chunk_index").eq("id", chunkId).maybeSingle(),
        supabase.from("study_chunk_words").select("*").eq("chunk_id", chunkId).order("position"),
      ]);
      if (cancelled) return;
      if (!chunk) {
        toast.error(t("chunk.notFound"));
        navigate(-1);
        return;
      }
      setEpisodeId(chunk.episode_id);
      setChunkIndex(chunk.chunk_index);
      const { data: cache } = await supabase
        .from("episode_vocab_cache")
        .select("vocab")
        .eq("episode_id", chunk.episode_id)
        .eq("language", learningLanguage)
        .maybeSingle();
      if (cancelled) return;

      const latestReadings = new Map(
        ((Array.isArray(cache?.vocab) ? cache.vocab : []) as EpisodeVocabWord[]).map((item) => [
          item.word,
          item.reading ?? null,
        ]),
      );
      const list = ((words ?? []) as ChunkWord[]).map((item) => ({
        ...item,
        reading: latestReadings.get(item.word) ?? item.reading,
      }));
      setAllWords(list);

      const wordKeys = Array.from(new Set(list.map((w) => w.word).filter(Boolean)));
      const { data: stateRows } = wordKeys.length
        ? await fetchBatchedPages<string, StateDbRow>(wordKeys, 200, (slice, from, to) =>
            supabase
              .from("user_word_state")
              .select("word,reading,level,state,preference,known_source,correct_streak,srs_level,srs_due_at,last_reviewed_at,marked_known_at")
              .in("word", slice)
              .eq("user_id", userId)
              .eq("learning_language", learningLanguage)
              .order("word", { ascending: true })
              .range(from, to),
          )
        : { data: [] as StateDbRow[] };
      if (cancelled) return;

      const pStreak: Record<string, number> = {};
      const recordMap: Record<string, WordSrsRecord> = {};
      for (const s of stateRows) {
        pStreak[s.word] = s.correct_streak ?? 0;
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
      setPersistStreak(pStreak);

      const shuffled = [...list].sort(() => Math.random() - 0.5);
      setQueue(shuffled);
      setCurrent(shuffled[0] ?? null);

      const { data: sess } = await supabase
        .from("study_sessions")
        .insert({
          user_id: userId,
          episode_id: chunk.episode_id,
          chunk_id: chunk.id,
          mode: "review",
          words_studied: 0,
          words_mastered: 0,
          learning_language: learningLanguage,
        })
        .select("id")
        .single();
      if (!cancelled && sess) setSessionId(sess.id);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [chunkId, userId, learningLanguage, navigate, t]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    const primeVoices = () => { synth.getVoices(); };
    primeVoices();
    synth.onvoiceschanged = primeVoices;
    return () => {
      synth.cancel();
      utteranceRef.current = null;
      synth.onvoiceschanged = null;
    };
  }, []);

  const totalRemaining = queue.length;
  const totalWords = allWords.length;
  const progress = totalWords ? Math.round(((totalWords - totalRemaining) / totalWords) * 100) : 0;

  const showKanji = useMemo(() => {
    if (!current) return false;
    if (!learningLanguageInfo.hasRuby) return false;
    if (current.word === current.reading) return true;
    return (persistStreak[current.word] ?? 0) >= KANJI_THRESHOLD;
  }, [current, persistStreak, learningLanguageInfo]);

  const recordWordOptimistic = (
    word: string,
    reading: string | null,
    level: string | null,
    gotItRight: boolean,
    graduated: boolean,
  ) => {
    const prevRecord = wordRecordsRef.current[word];
    const normalizedLevel = level === "none" ? null : level;

    if (graduated || !gotItRight) {
      const nextRecord = computeNextSrsState(
        prevRecord,
        { word, reading, level: normalizedLevel },
        gotItRight,
      );
      wordRecordsRef.current[word] = nextRecord;
      setPersistStreak((prev) => ({ ...prev, [word]: nextRecord.correct_streak }));
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
      return;
    }

    // Intermediate positive pass inside chunk before graduation
    const prevStreak = prevRecord?.correct_streak ?? persistStreak[word] ?? 0;
    const newStreak = prevStreak + 1;
    const nowIso = new Date().toISOString();
    const updated: WordSrsRecord = {
      word,
      reading: reading ?? prevRecord?.reading ?? null,
      level: normalizedLevel ?? prevRecord?.level ?? null,
      state: prevRecord?.state ?? "learning",
      preference: prevRecord?.preference ?? "study",
      known_source: prevRecord?.known_source ?? null,
      correct_streak: newStreak,
      srs_level: prevRecord?.srs_level ?? 0,
      srs_due_at: prevRecord?.srs_due_at ?? null,
      last_reviewed_at: nowIso,
      marked_known_at: prevRecord?.marked_known_at ?? null,
    };
    wordRecordsRef.current[word] = updated;
    setPersistStreak((prev) => ({ ...prev, [word]: newStreak }));
    if (!user) return;
    void supabase
      .from("user_word_state")
      .upsert(
        {
          user_id: user.id,
          word: updated.word,
          reading: updated.reading,
          level: updated.level,
          learning_language: learningLanguage,
          state: updated.state,
          preference: updated.preference,
          known_source: updated.known_source,
          correct_streak: updated.correct_streak,
          srs_level: updated.srs_level,
          srs_due_at: updated.srs_due_at,
          last_reviewed_at: updated.last_reviewed_at,
          marked_known_at: updated.marked_known_at ?? null,
        },
        { onConflict: "user_id,word,learning_language" },
      )
      .then(() => {
        invalidateLocalSrsCache(user.id, learningLanguage);
      });
  };

  const advance = (afterRemove: boolean) => {
    setFlipped(false);
    setShowFurigana(false);
    const [head, ...rest] = queue;
    if (!head) return;
    setHistory((h) => [...h, queue]);
    let next: ChunkWord[];
    if (afterRemove) {
      next = rest;
    } else {
      next = [...rest];
      const insertAt = next.length === 0 ? 0 : Math.floor(Math.random() * next.length) + 1;
      next.splice(insertAt, 0, head);
    }
    setQueue(next);
    setCurrent(next[0] ?? null);
  };

  const onSkipBack = () => {
    if (history.length === 0) return;
    setFlipped(false);
    setShowFurigana(false);
    const prevQueue = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setQueue(prevQueue);
    setCurrent(prevQueue[0] ?? null);
  };

  const onKnow = () => {
    if (!current) return;
    const newStreak = (sessionStreak[current.word] ?? 0) + 1;
    const graduated = newStreak >= REQUIRED_KNOWN;
    recordWordOptimistic(current.word, current.reading, current.level, true, graduated);
    setSessionStreak((s) => ({ ...s, [current.word]: newStreak }));
    if (graduated) {
      setDoneCount((d) => d + 1);
      advance(true);
    } else {
      advance(false);
    }
  };

  const onLearning = () => {
    if (!current) return;
    recordWordOptimistic(current.word, current.reading, current.level, false, false);
    setSessionStreak((s) => ({ ...s, [current.word]: 0 }));
    advance(false);
  };

  const onSkipForward = () => {
    advance(false);
  };

  const onDoneForSession = () => {
    if (!current) return;
    advance(true);
    toast.success(t("chunk.removedFromSession"));
  };

  // Finish when queue empty
  useEffect(() => {
    if (loading) return;
    if (allWords.length > 0 && queue.length === 0) {
      (async () => {
        if (sessionId) {
          await supabase.from("study_sessions").update({
            finished_at: new Date().toISOString(),
            words_studied: allWords.length,
            words_mastered: doneCount,
          }).eq("id", sessionId);
        }
        await supabase.from("study_chunks").update({ studied_at: new Date().toISOString() }).eq("id", chunkId!).is("studied_at", null);
      })();
    }
  }, [queue.length, loading, allWords.length, sessionId, doneCount, chunkId]);

  const speak = (text: string) => {
    if (!("speechSynthesis" in window)) return;
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = ttsLangFor(learningLanguage);
      u.rate = 0.95;
      const voices = synth.getVoices();
      const preferred = voices.find((voice) => voice.lang?.toLowerCase().startsWith(learningLanguage));
      if (preferred) u.voice = preferred;
      u.onerror = () => toast.error(t("chunk.audioFailed"));
      u.onend = () => {
        if (utteranceRef.current === u) utteranceRef.current = null;
      };
      utteranceRef.current = u;
      synth.speak(u);
    } catch (e) {
      console.error("speech failed", e);
      toast.error(t("chunk.audioFailed"));
    }
  };

  if (loading) {
    return <div className="min-h-[60vh] grid place-items-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  if (allWords.length === 0) {
    return (
      <div className="max-w-md mx-auto px-5 py-10 text-center">
        <p className="text-muted-foreground mb-4">{t("chunk.empty")}</p>
        <Button onClick={() => navigate(-1)}>{t("study.back")}</Button>
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <div className="max-w-md mx-auto px-5 py-10 text-center">
        <Card className="p-8 gradient-card border-border/50 shadow-card animate-fade-in">
          <div className="text-5xl mb-3">🎉</div>
          <h2 className="text-2xl font-bold mb-2">{t("chunk.completeTitle")}</h2>
          <p className="text-sm text-muted-foreground mb-6">
            {t("chunk.completeBody", { n: chunkIndex, done: doneCount, total: allWords.length })}
          </p>
          <div className="grid gap-2">
            <Button onClick={() => navigate(`/episode/${episodeId}`)} className="gradient-primary text-primary-foreground">
              {t("study.backToEpisode")}
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
        <div className="text-sm text-muted-foreground">{t("chunk.title", { n: chunkIndex })}</div>
        <div className="w-9" />
      </div>

      <Progress value={progress} className="h-2 mb-2" />
      <div className="text-xs text-muted-foreground text-center mb-4">
        {t("chunk.doneOf", { done: totalWords - totalRemaining, total: totalWords, remaining: totalRemaining })}
      </div>

      <div className="relative">
        <div className="flip-card h-72 mb-2" onClick={() => setFlipped((f) => !f)}>
          <div className={`flip-inner h-full ${flipped ? "flipped" : ""}`}>
            <Card className="flip-face absolute inset-0 gradient-card border-border/50 shadow-card grid place-items-center cursor-pointer">
              <div className="text-center px-6">
                <div className={cn("text-6xl font-bold mb-2", learningLanguageInfo.hasRuby && "font-jp")}>
                  {learningLanguageInfo.hasRuby ? ((showKanji ? current?.word : current?.reading) || current?.word) : current?.word}
                </div>
                {learningLanguageInfo.hasRuby && current && !showKanji && current.word !== current.reading && (
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    {t("study.hiraganaMode")}
                  </div>
                )}
                <div className="text-xs text-muted-foreground">{t("study.tapToFlip")}</div>
              </div>
            </Card>
            <Card className="flip-face flip-back gradient-card border-primary/30 shadow-elegant grid place-items-center cursor-pointer relative">
              {learningLanguageInfo.hasRuby && (
                <Button
                  variant={showFurigana ? "default" : "ghost"}
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); setShowFurigana((v) => !v); }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  aria-pressed={showFurigana}
                  title={t("study.toggleFurigana")}
                  className="absolute top-2 right-2 h-8 gap-1 px-2 z-20"
                >
                  <Languages className="h-3.5 w-3.5" />
                  <span className="font-jp text-[11px]">あ</span>
                </Button>
              )}
              <div className="text-center px-6">
                <div className={cn("text-3xl font-bold mb-1", learningLanguageInfo.hasRuby && "font-jp")}>{current?.word}</div>
                {learningLanguageInfo.hasRuby && current?.reading && current.reading !== current.word && (
                  <div className="font-jp text-base text-muted-foreground mb-3">{current.reading}</div>
                )}
                <div className="text-lg font-semibold mb-3">{current?.meaning}</div>
                <div className="text-xs text-muted-foreground italic">{current?.part_of_speech} • {current?.level}</div>
                {current?.example_sentence_jp && (
                  <div className="mt-4 text-xs">
                    {learningLanguageInfo.hasRuby ? (
                      <Furigana text={current.example_sentence_jp} show={showFurigana} className="font-jp text-sm leading-loose" />
                    ) : (
                      <div className="text-sm leading-loose">{current.example_sentence_jp}</div>
                    )}
                    <div className="text-muted-foreground mt-1">{current.example_sentence_en}</div>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>

        <button
          onClick={(e) => { e.stopPropagation(); onSkipBack(); }}
          aria-label={t("chunk.prevWord")}
          disabled={history.length === 0}
          className="absolute top-0 left-0 h-full w-14 flex items-center justify-center rounded-l-lg bg-background/0 hover:bg-background/40 active:bg-background/60 transition text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:bg-background/0"
        >
          <ChevronLeft className="h-7 w-7" />
        </button>

        <button
          onClick={(e) => { e.stopPropagation(); onSkipForward(); }}
          aria-label={t("chunk.nextWord")}
          className="absolute bottom-0 right-0 h-[calc(100%-3rem)] w-14 flex items-center justify-center rounded-br-lg bg-background/0 hover:bg-background/40 active:bg-background/60 transition text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className="h-7 w-7" />
        </button>
      </div>

      <div className="flex justify-center mb-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            if (current) {
              speak(current.reading || current.word);
            }
          }}
        >
          <Volume2 className="h-4 w-4" /> {t("study.playAudio")}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <Button variant="outline" onClick={onLearning} className="h-12">
          <X className="h-4 w-4" /> {t("study.stillLearning")}
        </Button>
        <Button onClick={onKnow} className="h-12 bg-success text-success-foreground hover:bg-success/90">
          <Check className="h-4 w-4" /> {t("study.iKnowThis")}
        </Button>
      </div>

      <div className="flex justify-center">
        <Button variant="ghost" size="sm" onClick={onDoneForSession} className="text-xs text-muted-foreground">
          {t("chunk.doneForNow")}
        </Button>
      </div>

      <TutorChat
        vocab={allWords.map((w) => ({
          word: w.word,
          reading: w.reading ?? "",
          meaning: w.meaning ?? "",
          part_of_speech: w.part_of_speech ?? "",
          jlpt_level: w.level ?? "",
          example_sentence_jp: w.example_sentence_jp ?? "",
          example_sentence_en: w.example_sentence_en ?? "",
        }))}
        focusWord={current?.word ?? null}
        onWordMarkedKnown={() => { /* persisted via TutorChat */ }}
      />
    </div>
  );
}

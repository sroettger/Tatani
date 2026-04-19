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

type ChunkWord = {
  word: string; reading: string | null; meaning: string | null;
  jlpt_level: string | null; part_of_speech: string | null;
  example_sentence_jp: string | null; example_sentence_en: string | null;
};

type EpisodeVocabWord = {
  word: string;
  reading?: string | null;
};

const KANJI_THRESHOLD = 2;
const REQUIRED_KNOWN = 2; // mark as "session-done" after 2 consecutive "I know this"

export default function StudyChunk() {
  const { chunkId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [chunkIndex, setChunkIndex] = useState<number>(0);
  const [allWords, setAllWords] = useState<ChunkWord[]>([]);
  // queue of words remaining in this session's rotation
  const [queue, setQueue] = useState<ChunkWord[]>([]);
  const [current, setCurrent] = useState<ChunkWord | null>(null);
  const [flipped, setFlipped] = useState(false);
  // session-only: per-word consecutive correct streak in THIS session
  const [sessionStreak, setSessionStreak] = useState<Record<string, number>>({});
  // persistent streak (from user_word_state) — controls kanji vs hiragana view
  const [persistStreak, setPersistStreak] = useState<Record<string, number>>({});
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [doneCount, setDoneCount] = useState(0);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  // Stack of previous queue snapshots so the user can step back.
  const [history, setHistory] = useState<ChunkWord[][]>([]);
  const [showFurigana, setShowFurigana] = useState(false);

  useEffect(() => {
    if (!chunkId || !user) return;
    (async () => {
      setLoading(true);
      const [{ data: chunk }, { data: words }] = await Promise.all([
        supabase.from("study_chunks").select("id,episode_id,chunk_index").eq("id", chunkId).maybeSingle(),
        supabase.from("study_chunk_words").select("*").eq("chunk_id", chunkId).order("position"),
      ]);
      if (!chunk) { toast.error("Chunk not found"); navigate(-1); return; }
      setEpisodeId(chunk.episode_id);
      setChunkIndex(chunk.chunk_index);
      const { data: cache } = await supabase
        .from("episode_vocab_cache")
        .select("vocab")
        .eq("episode_id", chunk.episode_id)
        .maybeSingle();
      const latestReadings = new Map(
        (((cache?.vocab ?? []) as EpisodeVocabWord[]).map((item) => [item.word, item.reading ?? null]))
      );
      const list = ((words ?? []) as ChunkWord[]).map((item) => ({
        ...item,
        reading: latestReadings.get(item.word) ?? item.reading,
      }));
      setAllWords(list);

      // Pull persistent state for these words
      const wordKeys = list.map(w => w.word);
      const { data: states } = wordKeys.length
        ? await supabase.from("user_word_state").select("word,correct_streak").in("word", wordKeys).eq("user_id", user.id)
        : { data: [] as any[] };
      const pStreak: Record<string, number> = {};
      (states ?? []).forEach((s: any) => {
        pStreak[s.word] = s.correct_streak ?? 0;
      });
      setPersistStreak(pStreak);

      // Shuffle initial queue
      const shuffled = [...list].sort(() => Math.random() - 0.5);
      setQueue(shuffled);
      setCurrent(shuffled[0] ?? null);

      // Create study session
      const { data: sess } = await supabase
        .from("study_sessions")
        .insert({ user_id: user.id, episode_id: chunk.episode_id, chunk_id: chunk.id, mode: "review", words_studied: 0, words_mastered: 0 })
        .select("id").single();
      if (sess) setSessionId(sess.id);
      setLoading(false);
    })();
  }, [chunkId, user]);

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
    if (current.word === current.reading) return true;
    return (persistStreak[current.word] ?? 0) >= KANJI_THRESHOLD;
  }, [current, persistStreak]);

  const recordWord = async (word: string, reading: string | null, jlpt: string | null, gotItRight: boolean) => {
    if (!user) return;
    const { data: existing } = await supabase
      .from("user_word_state").select("correct_streak").eq("user_id", user.id).eq("word", word).maybeSingle();
    const prevStreak = existing?.correct_streak ?? 0;
    const newStreak = gotItRight ? prevStreak + 1 : 0;

    // Note: we intentionally do NOT change `state` here. Words are only marked
    // as known via manual action on the episode page. We still track
    // `correct_streak` because it controls kanji vs. hiragana display.
    await supabase.from("user_word_state").upsert({
      user_id: user.id, word, reading: reading ?? null, jlpt_level: (jlpt as any) ?? null,
      correct_streak: newStreak, last_reviewed_at: new Date().toISOString(),
    }, { onConflict: "user_id,word" });
    setPersistStreak(prev => ({ ...prev, [word]: newStreak }));
  };

  const advance = (afterRemove: boolean) => {
    setFlipped(false);
    setShowFurigana(false);
    setQueue(prev => {
      // current is prev[0]
      const [head, ...rest] = prev;
      if (!head) return prev;
      setHistory(h => [...h, prev]);
      let next: ChunkWord[];
      if (afterRemove) {
        next = rest;
      } else {
        // re-insert at a random later position
        next = [...rest];
        const insertAt = next.length === 0 ? 0 : Math.floor(Math.random() * next.length) + 1;
        next.splice(insertAt, 0, head);
      }
      setCurrent(next[0] ?? null);
      return next;
    });
  };

  const onSkipBack = () => {
    setFlipped(false);
    setShowFurigana(false);
    setHistory(h => {
      if (h.length === 0) return h;
      const prevQueue = h[h.length - 1];
      setQueue(prevQueue);
      setCurrent(prevQueue[0] ?? null);
      return h.slice(0, -1);
    });
  };

  const onKnow = async () => {
    if (!current) return;
    await recordWord(current.word, current.reading, current.jlpt_level, true);
    const newStreak = (sessionStreak[current.word] ?? 0) + 1;
    setSessionStreak(s => ({ ...s, [current.word]: newStreak }));
    if (newStreak >= REQUIRED_KNOWN) {
      setDoneCount(d => d + 1);
      advance(true);
    } else {
      advance(false);
    }
  };
  const onLearning = async () => {
    if (!current) return;
    await recordWord(current.word, current.reading, current.jlpt_level, false);
    setSessionStreak(s => ({ ...s, [current.word]: 0 }));
    advance(false);
  };
  const onSkipForward = () => {
    // Right-arrow: just rotate to next without grading
    advance(false);
  };
  const onDoneForSession = () => {
    if (!current) return;
    advance(true);
    toast.success("Removed from this session");
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
        // Mark chunk as studied (first time)
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
      u.lang = "ja-JP";
      u.rate = 0.95;
      const voices = synth.getVoices();
      const jp = voices.find((voice) => voice.lang?.toLowerCase().startsWith("ja"));
      if (jp) u.voice = jp;
      u.onerror = () => toast.error("Audio playback failed");
      u.onend = () => {
        if (utteranceRef.current === u) utteranceRef.current = null;
      };
      utteranceRef.current = u;
      synth.speak(u);
    } catch (e) {
      console.error("speech failed", e);
      toast.error("Audio playback failed");
    }
  };

  if (loading) {
    return <div className="min-h-[60vh] grid place-items-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  if (allWords.length === 0) {
    return (
      <div className="max-w-md mx-auto px-5 py-10 text-center">
        <p className="text-muted-foreground mb-4">This chunk is empty.</p>
        <Button onClick={() => navigate(-1)}>Back</Button>
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <div className="max-w-md mx-auto px-5 py-10 text-center">
        <Card className="p-8 gradient-card border-border/50 shadow-card animate-fade-in">
          <div className="text-5xl mb-3">🎉</div>
          <h2 className="text-2xl font-bold mb-2">Chunk done!</h2>
          <p className="text-sm text-muted-foreground mb-6">
            You completed Chunk {chunkIndex} ({doneCount} / {allWords.length} marked known).
          </p>
          <div className="grid gap-2">
            <Button onClick={() => navigate(`/episode/${episodeId}`)} className="gradient-primary text-primary-foreground">
              Back to episode
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
        <div className="text-sm text-muted-foreground">Chunk {chunkIndex}</div>
        <div className="w-9" />
      </div>

      <Progress value={progress} className="h-2 mb-2" />
      <div className="text-xs text-muted-foreground text-center mb-4">
        {totalWords - totalRemaining} / {totalWords} done · {totalRemaining} in rotation
      </div>

      <div className="relative">
        <div className="flip-card h-72 mb-2" onClick={() => setFlipped(f => !f)}>
          <div className={`flip-inner h-full ${flipped ? "flipped" : ""}`}>
            <Card className="flip-face absolute inset-0 gradient-card border-border/50 shadow-card grid place-items-center cursor-pointer">
              <div className="text-center px-6">
                <div className="font-jp text-6xl font-bold mb-2">
                  {showKanji ? current?.word : current?.reading}
                </div>
                {current && !showKanji && current.word !== current.reading && (
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    Hiragana mode
                  </div>
                )}
                <div className="text-xs text-muted-foreground">Tap to flip</div>
              </div>
            </Card>
            <Card className="flip-face flip-back gradient-card border-primary/30 shadow-elegant grid place-items-center cursor-pointer relative">
              <Button
                variant={showFurigana ? "default" : "ghost"}
                size="sm"
                onClick={(e) => { e.stopPropagation(); setShowFurigana(v => !v); }}
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                aria-pressed={showFurigana}
                title="Toggle furigana"
                className="absolute top-2 right-2 h-8 gap-1 px-2 z-20"
              >
                <Languages className="h-3.5 w-3.5" />
                <span className="font-jp text-[11px]">あ</span>
              </Button>
              <div className="text-center px-6">
                <div className="font-jp text-3xl font-bold mb-1">{current?.word}</div>
                {current?.reading && current.reading !== current.word && (
                  <div className="font-jp text-base text-muted-foreground mb-3">{current.reading}</div>
                )}
                <div className="text-lg font-semibold mb-3">{current?.meaning}</div>
                <div className="text-xs text-muted-foreground italic">{current?.part_of_speech} • {current?.jlpt_level}</div>
                {current?.example_sentence_jp && (
                  <div className="mt-4 text-xs">
                    <Furigana text={current.example_sentence_jp} show={showFurigana} className="font-jp text-sm leading-loose" />
                    <div className="text-muted-foreground mt-1">{current.example_sentence_en}</div>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>

        {/* Left-side transparent skip-back arrow */}
        <button
          onClick={(e) => { e.stopPropagation(); onSkipBack(); }}
          aria-label="Previous word"
          disabled={history.length === 0}
          className="absolute top-0 left-0 h-full w-14 flex items-center justify-center rounded-l-lg bg-background/0 hover:bg-background/40 active:bg-background/60 transition text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:bg-background/0"
        >
          <ChevronLeft className="h-7 w-7" />
        </button>

        {/* Right-side transparent skip-forward arrow — leave space for furigana toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); onSkipForward(); }}
          aria-label="Next word"
          className="absolute bottom-0 right-0 h-[calc(100%-3rem)] w-14 flex items-center justify-center rounded-br-lg bg-background/0 hover:bg-background/40 active:bg-background/60 transition text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className="h-7 w-7" />
        </button>
      </div>

      <div className="flex justify-center mb-3">
        <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); current && speak(current.reading || current.word); }}>
          <Volume2 className="h-4 w-4" /> Play audio
        </Button>
      </div>

      <div className="flex justify-center">
        <Button variant="ghost" size="sm" onClick={onDoneForSession} className="text-xs text-muted-foreground">
          Done with this word for now
        </Button>
      </div>

      <TutorChat
        vocab={allWords.map(w => ({
          word: w.word, reading: w.reading ?? "", meaning: w.meaning ?? "",
          part_of_speech: w.part_of_speech ?? "", jlpt_level: w.jlpt_level ?? "",
          example_sentence_jp: w.example_sentence_jp ?? "", example_sentence_en: w.example_sentence_en ?? "",
        }))}
        focusWord={current?.word ?? null}
        onWordMarkedKnown={() => { /* persisted via TutorChat */ }}
      />
    </div>
  );
}


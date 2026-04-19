import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { ChevronLeft, Loader2, RotateCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";

type Chunk = { id: string; chunk_index: number; word_count: number; studied_at: string | null };
type ChunkWord = {
  word: string; reading: string | null; meaning: string | null;
  jlpt_level: string | null; part_of_speech: string | null;
};

const KANJI_THRESHOLD = 2;

export default function ChunkQuiz() {
  const { episodeId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [phase, setPhase] = useState<"select" | "quiz" | "done">("select");

  // quiz state
  const [words, setWords] = useState<ChunkWord[]>([]);
  const [persistStreak, setPersistStreak] = useState<Record<string, number>>({});
  
  const [idx, setIdx] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [choice, setChoice] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!episodeId || !user) return;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("study_chunks")
        .select("id,chunk_index,word_count,studied_at")
        .eq("user_id", user.id).eq("episode_id", episodeId)
        .not("studied_at", "is", null)
        .order("chunk_index");
      const list = (data ?? []) as Chunk[];
      setChunks(list);
      // Pre-select all by default
      const sel: Record<string, boolean> = {};
      list.forEach(c => { sel[c.id] = true; });
      setSelected(sel);
      setLoading(false);
    })();
  }, [episodeId, user]);

  const selectedIds = useMemo(() => Object.entries(selected).filter(([, v]) => v).map(([k]) => k), [selected]);
  const allSelected = chunks.length > 0 && selectedIds.length === chunks.length;

  const startQuiz = async () => {
    if (!user || selectedIds.length === 0) {
      toast.error("Pick at least one chunk");
      return;
    }
    const { data: w } = await supabase
      .from("study_chunk_words").select("*").in("chunk_id", selectedIds);
    const allWords = (w ?? []) as ChunkWord[];
    if (allWords.length < 2) {
      toast.error("Not enough words to quiz");
      return;
    }
    // dedupe by word
    const seen = new Set<string>();
    const deduped: ChunkWord[] = [];
    for (const word of allWords) {
      if (!seen.has(word.word)) { seen.add(word.word); deduped.push(word); }
    }
    const shuffled = [...deduped].sort(() => Math.random() - 0.5);

    const wordKeys = shuffled.map(w => w.word);
    const { data: states } = await supabase
      .from("user_word_state").select("word,correct_streak").in("word", wordKeys).eq("user_id", user.id);
    const pStreak: Record<string, number> = {};
    (states ?? []).forEach((s: any) => {
      pStreak[s.word] = s.correct_streak ?? 0;
    });
    setPersistStreak(pStreak);
    setWords(shuffled);
    setIdx(0); setCorrect(0); setChoice(null);

    const { data: sess } = await supabase
      .from("study_sessions")
      .insert({ user_id: user.id, episode_id: episodeId!, mode: "quiz", words_studied: 0, words_mastered: 0 })
      .select("id").single();
    if (sess) setSessionId(sess.id);
    setPhase("quiz");
  };

  const card = words[idx];

  const distractors = useMemo(() => {
    if (!card) return [];
    const others = words.filter(v => v.word !== card.word).map(v => v.meaning).filter(Boolean) as string[];
    const shuffled = [...others].sort(() => Math.random() - 0.5).slice(0, 3);
    const all = [card.meaning ?? "", ...shuffled];
    return all.sort(() => Math.random() - 0.5);
  }, [card, words]);

  const correctIndex = useMemo(() => distractors.indexOf(card?.meaning ?? ""), [distractors, card]);

  const showKanji = useMemo(() => {
    if (!card) return false;
    if (card.word === card.reading) return true;
    return (persistStreak[card.word] ?? 0) >= KANJI_THRESHOLD;
  }, [card, persistStreak]);

  const onAnswer = async (i: number) => {
    if (!card || choice !== null) return;
    setChoice(i);
    const isCorrect = i === correctIndex;
    if (isCorrect) setCorrect(c => c + 1);

    if (sessionId && user) {
      await supabase.from("quiz_results").insert({
        session_id: sessionId, user_id: user.id, word: card.word,
        was_correct: isCorrect, quiz_kind: "jp_to_meaning",
      });
    }

    // persist streak
    if (user) {
      const prev = persistStreak[card.word] ?? 0;
      const newStreak = isCorrect ? prev + 1 : 0;
      const newState = isCorrect && newStreak >= 3 ? "known" : (isCorrect ? "learning" : "learning");
      await supabase.from("user_word_state").upsert({
        user_id: user.id, word: card.word, reading: card.reading ?? null, jlpt_level: (card.jlpt_level as any) ?? null,
        state: newState as any, correct_streak: newStreak, last_reviewed_at: new Date().toISOString(),
      }, { onConflict: "user_id,word" });
      setPersistStreak(s => ({ ...s, [card.word]: newStreak }));
    }

    setTimeout(async () => {
      setChoice(null);
      if (idx + 1 < words.length) setIdx(idx + 1);
      else {
        if (sessionId) {
          await supabase.from("study_sessions").update({
            finished_at: new Date().toISOString(),
            words_studied: words.length,
            words_mastered: correct + (isCorrect ? 1 : 0),
          }).eq("id", sessionId);
        }
        setPhase("done");
      }
    }, 900);
  };

  if (loading) {
    return <div className="min-h-[60vh] grid place-items-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  if (phase === "select") {
    return (
      <div className="max-w-md mx-auto px-5 pt-4 pb-10">
        <div className="flex items-center justify-between mb-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}><ChevronLeft className="h-5 w-5" /></Button>
          <div className="text-sm text-muted-foreground">Quiz</div>
          <div className="w-9" />
        </div>
        <h1 className="text-xl font-bold mb-1">Choose chunks to quiz</h1>
        <p className="text-sm text-muted-foreground mb-4">Only chunks you've studied appear here.</p>

        {chunks.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            No studied chunks yet. Study at least one chunk to unlock the quiz.
          </Card>
        ) : (
          <>
            <Card className="p-3 mb-3 gradient-card border-border/50">
              <div className="flex items-center gap-3">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(c) => {
                    const sel: Record<string, boolean> = {};
                    chunks.forEach(ch => { sel[ch.id] = !!c; });
                    setSelected(sel);
                  }}
                />
                <div className="text-sm font-medium">Select all</div>
              </div>
            </Card>
            <div className="grid gap-2 mb-6">
              {chunks.map(c => (
                <Card key={c.id} className="p-3 gradient-card border-border/50">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <Checkbox
                      checked={!!selected[c.id]}
                      onCheckedChange={(v) => setSelected(s => ({ ...s, [c.id]: !!v }))}
                    />
                    <div className="flex-1">
                      <div className="font-medium text-sm">Chunk {c.chunk_index}</div>
                      <div className="text-xs text-muted-foreground">{c.word_count} words</div>
                    </div>
                  </label>
                </Card>
              ))}
            </div>
            <Button
              onClick={startQuiz}
              disabled={selectedIds.length === 0}
              className="w-full h-12 gradient-primary text-primary-foreground"
            >
              Start quiz ({selectedIds.length} chunk{selectedIds.length === 1 ? "" : "s"})
            </Button>
          </>
        )}
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="max-w-md mx-auto px-5 py-10 text-center">
        <Card className="p-8 gradient-card border-border/50 shadow-card animate-fade-in">
          <div className="text-5xl mb-3">🎉</div>
          <h2 className="text-2xl font-bold mb-2">Quiz complete</h2>
          <p className="text-sm text-muted-foreground mb-6">{correct} / {words.length} correct</p>
          <div className="grid gap-2">
            <Button onClick={() => navigate(`/episode/${episodeId}`)} className="gradient-primary text-primary-foreground">
              Back to episode
            </Button>
            <Button variant="outline" onClick={() => setPhase("select")}>
              <RotateCw className="h-4 w-4" /> Pick chunks again
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // quiz phase
  return (
    <div className="max-w-md mx-auto px-5 pt-4 pb-10">
      <div className="flex items-center justify-between mb-4">
        <Button variant="ghost" size="icon" onClick={() => setPhase("select")}><ChevronLeft className="h-5 w-5" /></Button>
        <div className="text-sm text-muted-foreground">Quiz</div>
        <div className="w-9" />
      </div>

      <Progress value={(idx / words.length) * 100} className="h-2 mb-2" />
      <div className="text-xs text-muted-foreground text-center mb-4">{Math.min(idx + 1, words.length)} / {words.length}</div>

      <Card className="p-6 gradient-card border-border/50 shadow-card mb-4 text-center">
        <div className="text-xs text-muted-foreground mb-2">What does this mean?</div>
        <div className="font-jp text-5xl font-bold mb-2">
          {showKanji ? card?.word : card?.reading}
        </div>
        {showKanji
          ? card?.reading && card.reading !== card.word && <div className="font-jp text-muted-foreground">{card.reading}</div>
          : card && card.word !== card.reading && (
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Hiragana mode</div>
          )}
      </Card>

      <div className="grid gap-2">
        {distractors.map((d, i) => {
          const isPicked = choice === i;
          const isCorrect = i === correctIndex;
          const showState = choice !== null;
          return (
            <Button
              key={i}
              variant="outline"
              onClick={(e) => { e.currentTarget.blur(); onAnswer(i); }}
              disabled={choice !== null}
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
          onClick={(e) => { e.currentTarget.blur(); onAnswer(-1); }}
          disabled={choice !== null}
          className="h-12 mt-2 text-muted-foreground"
        >
          I don't know
        </Button>
      </div>
    </div>
  );
}

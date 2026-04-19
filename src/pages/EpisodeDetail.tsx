import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, Loader2, Upload, Sparkles, BookOpen, BrainCircuit, Volume2, Plus, Mic, Layers, Check, Type, CheckCircle2, RotateCw, Tv } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { TutorChat } from "@/components/TutorChat";
import { cn } from "@/lib/utils";

// JLPT difficulty rank — higher number = harder. "none" treated as harder than N1
// so unclassified/proper-noun vocab is never auto-skipped.
const JLPT_RANK: Record<string, number> = { N5: 1, N4: 2, N3: 3, N2: 4, N1: 5, none: 6 };
const CHUNK_SIZE = 10;

type VocabItem = {
  word: string;
  reading: string;
  meaning: string;
  part_of_speech: string;
  jlpt_level: string;
  example_sentence_jp: string;
  example_sentence_en: string;
};
type SentenceItem = { jp: string; en: string };
type WordPref = "study" | "kanji_only" | "skip";
type WordState = "unknown" | "learning" | "known";
type WordRow = { word: string; state: WordState; preference: WordPref };

export default function EpisodeDetail() {
  const { episodeId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);
  const [episode, setEpisode] = useState<{ id: string; episode_number: number; processing_status: string; processing_chunks_total: number; processing_chunks_done: number } | null>(null);
  const [vocab, setVocab] = useState<VocabItem[]>([]);
  const [sentences, setSentences] = useState<SentenceItem[]>([]);
  const [wordStates, setWordStates] = useState<Map<string, WordRow>>(new Map());
  const [busy, setBusy] = useState(false);
  const [progressStage, setProgressStage] = useState<string>("");
  const [showAll, setShowAll] = useState(false);
  const [showKnown, setShowKnown] = useState(false);
  const [showQueue, setShowQueue] = useState(true);
  const [chunks, setChunks] = useState<{ id: string; chunk_index: number; word_count: number; studied_at: string | null }[]>([]);
  const [chunkifying, setChunkifying] = useState(false);

  const load = async () => {
    if (!episodeId || !user) return;
    const { data: ep } = await supabase.from("episodes").select("id,episode_number,processing_status,processing_chunks_total,processing_chunks_done").eq("id", episodeId).maybeSingle();
    setEpisode(ep as any);
    const { data: cache } = await supabase.from("episode_vocab_cache").select("vocab,sentences").eq("episode_id", episodeId).maybeSingle();
    setVocab(((cache?.vocab ?? []) as VocabItem[]));
    setSentences(((cache?.sentences ?? []) as SentenceItem[]));
    const { data: words } = await supabase.from("user_word_state").select("word,state,preference").eq("user_id", user.id);
    const map = new Map<string, WordRow>();
    (words ?? []).forEach((w: any) => map.set(w.word, { word: w.word, state: w.state, preference: w.preference }));
    setWordStates(map);
    const { data: ch } = await supabase
      .from("study_chunks")
      .select("id,chunk_index,word_count,studied_at")
      .eq("user_id", user.id).eq("episode_id", episodeId)
      .order("chunk_index");
    setChunks((ch ?? []) as any);
    return ep;
  };

  useEffect(() => {
    load();
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
    // eslint-disable-next-line
  }, [episodeId, user]);

  // Poll while processing
  useEffect(() => {
    if (episode?.processing_status === "processing" && !pollRef.current) {
      setBusy(true);
      setProgressStage("Extracting vocabulary with AI…");
      pollRef.current = window.setInterval(async () => {
        const ep = await load();
        if ((ep as any)?.processing_status === "ready") {
          if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
          setBusy(false); setProgressStage("");
          toast.success("Episode processed!");
        } else if ((ep as any)?.processing_status === "failed") {
          if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
          setBusy(false); setProgressStage("");
          toast.error("Processing failed", { description: "Please try again." });
        }
      }, 3000);
    }
  }, [episode?.processing_status]);

  const startProcess = async (subText: string) => {
    if (!episodeId) return;
    setBusy(true);
    setProgressStage("Sending subtitles to AI…");
    const { data, error } = await supabase.functions.invoke("process-episode", {
      body: { episode_id: episodeId, subtitle_text: subText },
    });
    if (error) { setBusy(false); setProgressStage(""); toast.error("Processing failed", { description: error.message }); return; }
    if ((data as any)?.error) { setBusy(false); setProgressStage(""); toast.error("Processing failed", { description: (data as any).error }); return; }
    if ((data as any)?.cached) {
      setBusy(false); setProgressStage("");
      toast.success("Loaded from cache");
      load();
      return;
    }
    setProgressStage("Extracting vocabulary with AI… (this can take 1–2 minutes)");
    await load();
  };

  const tryAutoFetch = async () => {
    if (!episodeId) return;
    setBusy(true);
    setProgressStage("Fetching Japanese subtitles…");
    const { data, error } = await supabase.functions.invoke("fetch-subtitles", { body: { episode_id: episodeId } });
    if (error) { setBusy(false); setProgressStage(""); toast.error("Subtitle fetch failed", { description: error.message }); return; }
    if (!data?.found) {
      setBusy(false); setProgressStage("");
      toast.message("No auto-subtitles found", { description: "Upload a .srt or .ass file to continue." });
      fileRef.current?.click();
      return;
    }
    await startProcess(data.content);
  };

  const onUpload = async (file: File) => {
    const text = await file.text();
    await startProcess(text);
  };

  const speak = (text: string) => {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  };

  // Level-based defaulting: words below user's JLPT level default to "known" unless user overrode.
  const myLevel = profile?.jlpt_level && profile.jlpt_level !== "none" ? profile.jlpt_level : null;
  const myRank = myLevel ? JLPT_RANK[myLevel] : 0;
  const isBelowLevel = (lvl: string) => myRank > 0 && (JLPT_RANK[lvl] ?? 99) < myRank;

  // Effective bucket for a word: "known" | "new" (with preference)
  const bucketOf = (v: VocabItem): "known" | "new" => {
    const s = wordStates.get(v.word);
    if (s?.state === "known") return "known";
    if (s) return "new"; // user explicitly set it as not-known
    if (isBelowLevel(v.jlpt_level)) return "known"; // auto-skip default
    return "new";
  };

  const prefOf = (word: string): WordPref => wordStates.get(word)?.preference ?? "study";

  // Importance score: how central is this word to the episode's story.
  // Signals: (a) how often it appears across the AI-extracted example sentences for THIS episode,
  // (b) JLPT commonness (lower JLPT level = more common Japanese word = more likely to recur).
  // Higher = more important.
  const JLPT_COMMONNESS: Record<string, number> = { N5: 5, N4: 4, N3: 3, N2: 2, N1: 1, none: 0 };
  const { importance, frequency } = useMemo(() => {
    const corpus = [
      ...vocab.flatMap(v => [v.example_sentence_jp ?? ""]),
      ...sentences.map(s => s.jp ?? ""),
    ].join("\n");
    const score = new Map<string, number>();
    const freqMap = new Map<string, number>();
    for (const v of vocab) {
      const w = v.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let freq = 0;
      if (w) {
        const re = new RegExp(w, "g");
        freq = (corpus.match(re) ?? []).length;
      }
      freqMap.set(v.word, freq);
      score.set(v.word, freq * 10 + (JLPT_COMMONNESS[v.jlpt_level] ?? 0));
    }
    return { importance: score, frequency: freqMap };
  }, [vocab, sentences]);

  const byImportance = (a: VocabItem, b: VocabItem) =>
    (importance.get(b.word) ?? 0) - (importance.get(a.word) ?? 0);

  const sortedVocab = useMemo(() => [...vocab].sort(byImportance), [vocab, importance]);
  const newVocab = useMemo(() => sortedVocab.filter(v => bucketOf(v) === "new"), [sortedVocab, wordStates, myRank]);
  const knownVocab = useMemo(() => sortedVocab.filter(v => bucketOf(v) === "known"), [sortedVocab, wordStates, myRank]);
  // Queue = up to 30 most-important words to learn next (study/kanji_only preference, not skipped).
  const QUEUE_SIZE = 30;
  const queueVocab = useMemo(
    () => newVocab.filter(v => prefOf(v.word) !== "skip").slice(0, QUEUE_SIZE),
    [newVocab, wordStates]
  );

  // Chunkify-staleness: chunks reflect the current "to learn" queue (max QUEUE_SIZE words).
  const studyableCount = queueVocab.length;
  const chunkedCount = chunks.reduce((s, c) => s + c.word_count, 0);
  const chunksStale = chunks.length > 0 && chunkedCount !== studyableCount;

  const upsertWord = async (v: VocabItem, patch: Partial<Pick<WordRow, "state" | "preference">>) => {
    if (!user) return;
    const prev = wordStates.get(v.word);
    const next: WordRow = {
      word: v.word,
      state: (patch.state ?? prev?.state ?? "unknown") as WordState,
      preference: (patch.preference ?? prev?.preference ?? "study") as WordPref,
    };
    setWordStates(m => {
      const nm = new Map(m);
      nm.set(v.word, next);
      return nm;
    });
    await supabase.from("user_word_state").upsert({
      user_id: user.id,
      word: v.word,
      reading: v.reading,
      jlpt_level: (v.jlpt_level as any) ?? null,
      state: next.state,
      preference: next.preference,
    }, { onConflict: "user_id,word" });
  };

  const markKnown = (v: VocabItem) => upsertWord(v, { state: "known" });
  const markNew = (v: VocabItem) => upsertWord(v, { state: "unknown" });
  const togglePref = (v: VocabItem) => {
    const cur = prefOf(v.word);
    const hasKanji = v.word !== v.reading;
    if (!hasKanji) return;
    upsertWord(v, { preference: cur === "kanji_only" ? "study" : "kanji_only" });
  };

  const chunkify = async () => {
    if (!user || !episodeId) return;
    const studyable = newVocab.filter(v => prefOf(v.word) !== "skip");
    if (studyable.length === 0) {
      toast.error("No words to chunkify");
      return;
    }
    setChunkifying(true);
    await supabase.from("study_chunks").delete().eq("user_id", user.id).eq("episode_id", episodeId);
    const groups: VocabItem[][] = [];
    for (let i = 0; i < studyable.length; i += CHUNK_SIZE) groups.push(studyable.slice(i, i + CHUNK_SIZE));
    for (let idx = 0; idx < groups.length; idx++) {
      const { data: chunk, error: cErr } = await supabase
        .from("study_chunks")
        .insert({ user_id: user.id, episode_id: episodeId, chunk_index: idx + 1, word_count: groups[idx].length })
        .select("id").single();
      if (cErr || !chunk) { toast.error("Failed to create chunk"); setChunkifying(false); return; }
      const wordRows = groups[idx].map((v, pos) => ({
        chunk_id: chunk.id,
        word: v.word,
        reading: v.reading,
        meaning: v.meaning,
        jlpt_level: (v.jlpt_level as any) ?? null,
        part_of_speech: v.part_of_speech,
        example_sentence_jp: v.example_sentence_jp,
        example_sentence_en: v.example_sentence_en,
        position: pos,
      }));
      const { error: wErr } = await supabase.from("study_chunk_words").insert(wordRows);
      if (wErr) { toast.error("Failed to save chunk words"); setChunkifying(false); return; }
    }
    toast.success(`Created ${groups.length} chunk${groups.length === 1 ? "" : "s"}`);
    setChunkifying(false);
    await load();
  };

  return (
    <div className="max-w-2xl mx-auto px-5 pt-4 pb-10">
      <div className="flex items-center justify-between mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}><ChevronLeft className="h-5 w-5" /></Button>
        <div className="text-sm text-muted-foreground">Episode {episode?.episode_number}</div>
        <div className="w-9" />
      </div>

      {vocab.length === 0 ? (
        <Card className="p-6 text-center gradient-card border-border/50 shadow-card">
          <Sparkles className="h-10 w-10 mx-auto text-primary mb-3" />
          <h2 className="text-lg font-semibold mb-1">
            {busy ? "Processing episode…" : "Process this episode"}
          </h2>
          <p className="text-sm text-muted-foreground mb-5">
            {busy
              ? (progressStage || "Working on it…")
              : "We'll auto-fetch the Japanese subtitles, extract vocabulary with AI, and generate flashcards just for you."}
          </p>
          {busy && (() => {
            const total = episode?.processing_chunks_total ?? 0;
            const done = episode?.processing_chunks_done ?? 0;
            const hasChunks = total > 0;
            const pct = hasChunks ? Math.round((done / total) * 100) : 15;
            return (
              <div className="mb-5">
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full gradient-primary transition-all duration-500 ${hasChunks ? "" : "animate-pulse"}`}
                    style={{ width: `${hasChunks ? pct : 33}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  {hasChunks
                    ? `Processed ${done} of ${total} chunks (${pct}%) — you can leave this page, processing continues in the background.`
                    : "You can leave this page — processing continues in the background."}
                </p>
              </div>
            );
          })()}
          <div className="grid gap-2">
            <Button onClick={tryAutoFetch} disabled={busy} className="gradient-primary text-primary-foreground h-12">
              {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Working…</> : <><Sparkles className="h-4 w-4" /> Auto-fetch & process</>}
            </Button>
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy} className="h-12">
              <Upload className="h-4 w-4" /> Upload subtitle file
            </Button>
            <input
              ref={fileRef} type="file" accept=".srt,.ass,.ssa,.vtt,.txt"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); }}
            />
          </div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 mb-4">
            <StatBox
              label="To learn"
              value={`${queueVocab.length}/${Math.min(newVocab.length, QUEUE_SIZE)}`}
              accent="text-primary"
              active={showQueue}
              onClick={() => { setShowQueue(s => !s); setShowAll(false); setShowKnown(false); }}
            />
            <StatBox
              label="Known"
              value={knownVocab.length}
              accent="text-success"
              active={showKnown}
              onClick={() => { setShowKnown(s => !s); setShowAll(false); setShowQueue(false); }}
            />
            <StatBox
              label="All"
              value={vocab.length}
              accent="text-foreground"
              active={showAll}
              onClick={() => { setShowAll(s => !s); setShowKnown(false); setShowQueue(false); }}
            />
          </div>

          {showQueue && (
            <Card className="p-3 mb-4 gradient-card border-border/50">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  To learn next ({queueVocab.length})
                  {newVocab.length > QUEUE_SIZE && (
                    <span className="ml-1 normal-case tracking-normal text-muted-foreground/70">· {newVocab.length - QUEUE_SIZE} more queued</span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground/80 flex items-center gap-2">
                  <span className="inline-flex items-center gap-1"><Type className="h-3 w-3" />kanji-only</span>
                  <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />known</span>
                </div>
              </div>
              {queueVocab.length === 0 ? (
                <div className="text-sm text-muted-foreground">Queue empty — you've mastered everything in this episode!</div>
              ) : (
                <div className="grid gap-1 max-h-96 overflow-y-auto">
                  {queueVocab.map((v) => renderQueueRow(v, prefOf, togglePref, markKnown, frequency.get(v.word) ?? 0))}
                </div>
              )}
            </Card>
          )}

          {showAll && (
            <Card className="p-3 mb-4 gradient-card border-border/50">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">All words ({vocab.length})</div>
              <div className="grid gap-1 max-h-96 overflow-y-auto">
                {sortedVocab.map((v) => {
                  const bucket = bucketOf(v);
                  return (
                    <div key={`${v.word}-${v.reading}`} className="flex items-center gap-2 py-1.5 border-b border-border/30 last:border-0">
                      <div className="min-w-0 flex-1">
                        <div className="font-jp text-sm truncate">
                          {v.word} <span className="text-muted-foreground text-xs">{v.reading}</span>
                        </div>
                        <div className="text-xs text-muted-foreground truncate">{v.meaning}</div>
                      </div>
                      <FreqBadge freq={frequency.get(v.word) ?? 0} />
                      <Badge variant="secondary" className="text-[10px] shrink-0">{v.jlpt_level}</Badge>
                      {bucket === "known" ? (
                        <Button size="sm" variant="ghost" className="h-7 px-2 shrink-0" onClick={() => markNew(v)}>
                          <Plus className="h-3 w-3" /> New
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" className="h-7 px-2 shrink-0 hover:text-success" onClick={() => markKnown(v)}>
                          <CheckCircle2 className="h-3 w-3" /> Known
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {showKnown && (
            <Card className="p-3 mb-4 gradient-card border-border/50">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Known words ({knownVocab.length})</div>
              {knownVocab.length === 0 ? (
                <div className="text-sm text-muted-foreground">No known words yet.</div>
              ) : (
                <div className="grid gap-1 max-h-96 overflow-y-auto">
                  {knownVocab.map((v) => {
                    const s = wordStates.get(v.word);
                    const reason = s?.state === "known" ? "known" : "below your level";
                    return (
                      <div key={`${v.word}-${v.reading}`} className="flex items-center gap-2 py-1.5 border-b border-border/30 last:border-0">
                        <div className="min-w-0 flex-1">
                          <div className="font-jp text-sm truncate">
                            {v.word} <span className="text-muted-foreground text-xs">{v.reading}</span>
                          </div>
                          <div className="text-xs text-muted-foreground truncate">{v.meaning}</div>
                          <div className="text-[10px] text-muted-foreground/70">{reason}</div>
                        </div>
                        <FreqBadge freq={frequency.get(v.word) ?? 0} />
                        <Badge variant="secondary" className="text-[10px] shrink-0">{v.jlpt_level}</Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 shrink-0"
                          onClick={() => markNew(v)}
                          title="Move back to new"
                        >
                          <Plus className="h-3 w-3" /> New
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          )}

          {/* Chunkify CTA */}
          <div className="grid gap-2 mb-6">
            {chunks.length === 0 ? (
              <Button
                className="w-full h-12 gradient-primary text-primary-foreground"
                onClick={chunkify}
                disabled={chunkifying || studyableCount === 0}
              >
                {chunkifying ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating chunks…</> : <><Layers className="h-4 w-4" /> Create chunks ({studyableCount} word{studyableCount === 1 ? "" : "s"})</>}
              </Button>
            ) : (
              <>
                <div className="flex items-center justify-between mb-1">
                  <h3 className="font-semibold flex items-center gap-2">
                    <Layers className="h-4 w-4 text-primary" /> Study chunks
                  </h3>
                  <Button
                    size="sm"
                    variant={chunksStale ? "default" : "ghost"}
                    className={cn("h-7 px-2 text-xs", chunksStale && "gradient-primary text-primary-foreground")}
                    onClick={chunkify}
                    disabled={chunkifying || studyableCount === 0}
                  >
                    {chunkifying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
                    Re-chunkify
                  </Button>
                </div>
                {chunksStale && (
                  <div className="text-xs text-accent mb-1">
                    Word list changed ({studyableCount} now vs {chunkedCount} chunked). Re-chunkify to refresh.
                  </div>
                )}
                <div className="grid gap-2">
                  {chunks.map(c => (
                    <Card
                      key={c.id}
                      onClick={() => navigate(`/study/chunk/${c.id}`)}
                      className="p-3 gradient-card border-border/50 cursor-pointer hover:border-primary/40 transition flex items-center justify-between"
                    >
                      <div>
                        <div className="font-medium text-sm flex items-center gap-2">
                          Chunk {c.chunk_index}
                          {c.studied_at && <Check className="h-3.5 w-3.5 text-success" />}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {c.word_count} word{c.word_count === 1 ? "" : "s"}
                          {c.studied_at ? " · Studied" : " · Not yet"}
                        </div>
                      </div>
                      <BookOpen className="h-4 w-4 text-muted-foreground" />
                    </Card>
                  ))}
                </div>
                <Button
                  variant="outline"
                  className="w-full h-11 mt-1"
                  onClick={() => navigate(`/episode/${episodeId}/quiz`)}
                  disabled={!chunks.some(c => c.studied_at)}
                >
                  <BrainCircuit className="h-4 w-4" /> Quiz studied chunks
                </Button>
              </>
            )}
            <Button
              variant="outline"
              className="w-full h-11"
              onClick={() => navigate(`/study/${episodeId}/voice`)}
              disabled={studyableCount === 0}
            >
              <Mic className="h-4 w-4" /> Hands-free voice mode
            </Button>
            <Button
              variant="outline"
              className="w-full h-11"
              onClick={() => navigate(`/episode/${episodeId}/watch`)}
            >
              <Tv className="h-4 w-4" /> Watch mode (Bingo)
            </Button>
          </div>

          <h3 className="font-semibold mb-2 flex items-center gap-2"><BrainCircuit className="h-4 w-4 text-primary" /> Sentences</h3>
          <div className="grid gap-2 mb-6">
            {sentences.slice(0, 8).map((s, i) => (
              <Card key={i} className="p-3 gradient-card border-border/50">
                <div className="flex items-start justify-between gap-2">
                  <div className="font-jp text-base flex-1">{s.jp}</div>
                  <Button size="icon" variant="ghost" onClick={() => speak(s.jp)}><Volume2 className="h-4 w-4" /></Button>
                </div>
                <div className="text-xs text-muted-foreground mt-1">{s.en}</div>
              </Card>
            ))}
          </div>
        </>
      )}

      <TutorChat
        vocab={vocab}
        onStartQuiz={() => navigate(`/study/${episodeId}`)}
        onWordMarkedKnown={(w) => setWordStates(prev => {
          const next = new Map(prev);
          const existing = next.get(w);
          next.set(w, { word: w, state: "known", preference: existing?.preference ?? "study" });
          return next;
        })}
      />
    </div>
  );
}

function StatBox({ label, value, accent, active, onClick }: { label: string; value: string | number; accent: string; active?: boolean; onClick?: () => void }) {
  const clickable = !!onClick;
  return (
    <Card
      onClick={onClick}
      className={`p-3 text-center gradient-card border-border/50 transition ${clickable ? "cursor-pointer hover:border-primary/40" : ""} ${active ? "border-primary/60 ring-1 ring-primary/30" : ""}`}
    >
      <div className={`text-xl font-bold ${accent}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </Card>
  );
}

function FreqBadge({ freq }: { freq: number }) {
  if (freq <= 0) return null;
  // Visual heat: 1 = subtle, 2 = warm, 3+ = hot.
  const tone = freq >= 3 ? "bg-primary/15 text-primary" : freq === 2 ? "bg-accent/15 text-accent" : "bg-muted text-muted-foreground";
  return (
    <span
      className={cn("text-[10px] px-1.5 py-0.5 rounded-full shrink-0 tabular-nums", tone)}
      title={`Appears ${freq}× in this episode's example sentences`}
    >
      ×{freq}
    </span>
  );
}

function renderQueueRow(
  v: VocabItem,
  prefOf: (w: string) => WordPref,
  togglePref: (v: VocabItem) => void,
  markKnown: (v: VocabItem) => void,
  freq: number,
) {
  const pref = prefOf(v.word);
  const hasKanji = v.word !== v.reading;
  const kanjiOnly = pref === "kanji_only";
  return (
    <div key={`${v.word}-${v.reading}`} className="flex flex-wrap items-center gap-2 py-2 border-b border-border/30 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="font-jp text-sm truncate">
          {v.word} <span className="text-muted-foreground text-xs">{v.reading}</span>
          {kanjiOnly && <span className="ml-1 text-[10px] text-accent">· kanji only</span>}
        </div>
        <div className="text-xs text-muted-foreground truncate">{v.meaning}</div>
      </div>
      <FreqBadge freq={freq} />
      <Badge variant="secondary" className="text-[10px] shrink-0">{v.jlpt_level}</Badge>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          size="sm"
          variant={kanjiOnly ? "default" : "outline"}
          className={cn("h-7 px-2 text-[11px] gap-1", !hasKanji && "opacity-30")}
          disabled={!hasKanji}
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => { togglePref(v); (e.currentTarget as HTMLButtonElement).blur(); }}
          title={hasKanji ? (kanjiOnly ? "Studying kanji only" : "Switch to kanji-only") : "No kanji in this word"}
        >
          <Type className="h-3 w-3" /> Kanji
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px] gap-1 hover:text-success"
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => { markKnown(v); (e.currentTarget as HTMLButtonElement).blur(); }}
          title="Mark as known"
        >
          <CheckCircle2 className="h-3 w-3" /> Known
        </Button>
      </div>
    </div>
  );
}

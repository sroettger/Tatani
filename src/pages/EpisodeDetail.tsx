import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, Loader2, Upload, Sparkles, BookOpen, BrainCircuit, Volume2, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";

// JLPT difficulty rank — higher number = harder. "none" treated as harder than N1
// so unclassified/proper-noun vocab is never auto-skipped.
const JLPT_RANK: Record<string, number> = { N5: 1, N4: 2, N3: 3, N2: 4, N1: 5, none: 6 };

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

export default function EpisodeDetail() {
  const { episodeId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);
  const [episode, setEpisode] = useState<{ id: string; episode_number: number; processing_status: string; processing_chunks_total: number; processing_chunks_done: number } | null>(null);
  const [vocab, setVocab] = useState<VocabItem[]>([]);
  const [sentences, setSentences] = useState<SentenceItem[]>([]);
  const [knownWords, setKnownWords] = useState<Set<string>>(new Set());
  const [addedBack, setAddedBack] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progressStage, setProgressStage] = useState<string>("");
  const [showSkipped, setShowSkipped] = useState(false);

  const load = async () => {
    if (!episodeId || !user) return;
    const { data: ep } = await supabase.from("episodes").select("id,episode_number,processing_status,processing_chunks_total,processing_chunks_done").eq("id", episodeId).maybeSingle();
    setEpisode(ep as any);
    const { data: cache } = await supabase.from("episode_vocab_cache").select("vocab,sentences").eq("episode_id", episodeId).maybeSingle();
    setVocab(((cache?.vocab ?? []) as VocabItem[]));
    setSentences(((cache?.sentences ?? []) as SentenceItem[]));
    const { data: words } = await supabase.from("user_word_state").select("word,state").eq("user_id", user.id).eq("state", "known");
    setKnownWords(new Set((words ?? []).map((w: any) => w.word)));
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
    // Background processing started — switch to polling
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

  // A word is "below my level" if its JLPT rank is strictly easier than my profile level.
  // E.g. profile=N4 (rank 2) → N5 (rank 1) is auto-skipped, N4/N3/etc. stay.
  const myLevel = profile?.jlpt_level && profile.jlpt_level !== "none" ? profile.jlpt_level : null;
  const myRank = myLevel ? JLPT_RANK[myLevel] : 0;
  const isBelowLevel = (lvl: string) => myRank > 0 && (JLPT_RANK[lvl] ?? 99) < myRank;

  const newVocab = vocab.filter(v =>
    !knownWords.has(v.word) && (!isBelowLevel(v.jlpt_level) || addedBack.has(v.word))
  );
  const skippedVocab = vocab.filter(v =>
    !addedBack.has(v.word) && (knownWords.has(v.word) || isBelowLevel(v.jlpt_level))
  );
  const masteryPct = vocab.length ? Math.round((skippedVocab.length / vocab.length) * 100) : 0;

  const addBack = async (v: VocabItem) => {
    if (!user) return;
    setAddedBack(prev => new Set(prev).add(v.word));
    // Persist as 'unknown' so it survives reloads and gets included in study.
    await supabase.from("user_word_state").upsert({
      user_id: user.id,
      word: v.word,
      reading: v.reading,
      jlpt_level: (v.jlpt_level as any) ?? null,
      state: "unknown" as const,
    }, { onConflict: "user_id,word" });
    // If this word was previously marked known, drop it from the local known set too.
    setKnownWords(prev => {
      const next = new Set(prev);
      next.delete(v.word);
      return next;
    });
    toast.success(`Added "${v.word}" to study`);
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
          <div className="grid grid-cols-3 gap-2 mb-6">
            <StatBox label="New" value={newVocab.length} accent="text-primary" />
            <StatBox label="Known" value={skippedVocab.length} accent="text-success" />
            <StatBox label="Mastery" value={`${masteryPct}%`} accent="text-accent" />
          </div>

          <Button
            className="w-full h-12 gradient-primary text-primary-foreground mb-6"
            onClick={() => navigate(`/study/${episodeId}`)}
            disabled={newVocab.length === 0}
          >
            <BookOpen className="h-4 w-4" /> Study {newVocab.length} cards
          </Button>

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

          {skippedVocab.length > 0 && (
            <div>
              <button
                onClick={() => setShowSkipped(s => !s)}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                {showSkipped ? "Hide" : "Show"} {skippedVocab.length} skipped (below your level or already known)
              </button>
              {showSkipped && (
                <div className="grid gap-2 mt-3">
                  {skippedVocab.map((v, i) => {
                    const reason = knownWords.has(v.word) ? "known" : "below level";
                    return (
                      <Card key={i} className="p-3 gradient-card border-border/50 flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-jp font-semibold truncate">{v.word} <span className="text-muted-foreground text-xs">{v.reading}</span></div>
                          <div className="text-xs text-muted-foreground truncate">{v.meaning}</div>
                          <div className="text-[10px] text-muted-foreground/70 mt-0.5">{reason}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant="secondary" className="text-[10px]">{v.jlpt_level}</Badge>
                          <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => addBack(v)}>
                            <Plus className="h-3 w-3" /> Add
                          </Button>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatBox({ label, value, accent }: { label: string; value: string | number; accent: string }) {
  return (
    <Card className="p-3 text-center gradient-card border-border/50">
      <div className={`text-xl font-bold ${accent}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </Card>
  );
}

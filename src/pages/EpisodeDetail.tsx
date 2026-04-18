import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, Loader2, Upload, Sparkles, BookOpen, BrainCircuit, Volume2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";

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
  const { user } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);
  const [episode, setEpisode] = useState<{ id: string; episode_number: number; processing_status: string } | null>(null);
  const [vocab, setVocab] = useState<VocabItem[]>([]);
  const [sentences, setSentences] = useState<SentenceItem[]>([]);
  const [knownWords, setKnownWords] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progressStage, setProgressStage] = useState<string>("");
  const [showSkipped, setShowSkipped] = useState(false);

  const load = async () => {
    if (!episodeId || !user) return;
    const { data: ep } = await supabase.from("episodes").select("id,episode_number,processing_status").eq("id", episodeId).maybeSingle();
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

  const newVocab = vocab.filter(v => !knownWords.has(v.word));
  const skippedVocab = vocab.filter(v => knownWords.has(v.word));
  const masteryPct = vocab.length ? Math.round((skippedVocab.length / vocab.length) * 100) : 0;

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
          <h2 className="text-lg font-semibold mb-1">Process this episode</h2>
          <p className="text-sm text-muted-foreground mb-5">
            We'll auto-fetch the Japanese subtitles, extract vocabulary with AI, and generate flashcards just for you.
          </p>
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
                {showSkipped ? "Hide" : "Show"} {skippedVocab.length} skipped (already known)
              </button>
              {showSkipped && (
                <div className="grid gap-2 mt-3">
                  {skippedVocab.map((v, i) => (
                    <Card key={i} className="p-3 gradient-card border-border/50 flex items-center justify-between">
                      <div>
                        <div className="font-jp font-semibold">{v.word} <span className="text-muted-foreground text-xs">{v.reading}</span></div>
                        <div className="text-xs text-muted-foreground">{v.meaning}</div>
                      </div>
                      <Badge variant="secondary" className="text-[10px]">{v.jlpt_level}</Badge>
                    </Card>
                  ))}
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

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, Loader2, Layers, BookOpen, Type, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";

type VocabItem = {
  word: string; reading: string; meaning: string; part_of_speech: string;
  jlpt_level: string; example_sentence_jp: string; example_sentence_en: string;
};

type Mode = "study" | "kanji_only" | "skip";

const CHUNK_SIZE = 10;
const JLPT_RANK: Record<string, number> = { N5: 1, N4: 2, N3: 3, N2: 4, N1: 5, none: 6 };

export default function EpisodePrereview() {
  const { episodeId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [vocab, setVocab] = useState<VocabItem[]>([]);
  const [modes, setModes] = useState<Record<string, Mode>>({});
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!episodeId || !user) return;
    (async () => {
      setLoading(true);
      const [{ data: cache }, { data: states }] = await Promise.all([
        supabase.from("episode_vocab_cache").select("vocab").eq("episode_id", episodeId).maybeSingle(),
        supabase.from("user_word_state").select("word,state,preference").eq("user_id", user.id),
      ]);
      const all = (cache?.vocab ?? []) as VocabItem[];
      const stateMap = new Map<string, { state: string; preference: string }>();
      (states ?? []).forEach((s: any) => stateMap.set(s.word, { state: s.state, preference: s.preference }));

      const myLevel = profile?.jlpt_level && profile.jlpt_level !== "none" ? profile.jlpt_level : null;
      const myRank = myLevel ? JLPT_RANK[myLevel] : 0;
      const isBelowLevel = (lvl: string) => myRank > 0 && (JLPT_RANK[lvl] ?? 99) < myRank;

      const candidates = all.filter(v => {
        const s = stateMap.get(v.word);
        if (s?.state === "known") return false;
        if (isBelowLevel(v.jlpt_level) && !s) return false;
        return true;
      });

      const initModes: Record<string, Mode> = {};
      candidates.forEach(v => {
        const s = stateMap.get(v.word);
        const pref = s?.preference;
        initModes[v.word] = pref === "skip" ? "skip" : pref === "kanji_only" ? "kanji_only" : "study";
      });
      setVocab(candidates);
      setModes(initModes);
      setLoading(false);
    })();
  }, [episodeId, user, profile?.jlpt_level]);

  const kept = useMemo(() => vocab.filter(v => modes[v.word] !== "skip"), [vocab, modes]);
  const chunkCount = Math.max(1, Math.ceil(kept.length / CHUNK_SIZE));

  const setMode = (word: string, mode: Mode) =>
    setModes(prev => ({ ...prev, [word]: mode }));

  const createChunks = async () => {
    if (!user || !episodeId) return;
    if (kept.length === 0) {
      toast.error("Select at least one word to study.");
      return;
    }
    setCreating(true);

    const prefRows = vocab.map(v => ({
      user_id: user.id,
      word: v.word,
      reading: v.reading,
      jlpt_level: (v.jlpt_level as any) ?? null,
      preference: (modes[v.word] ?? "study") as any,
      state: "unknown" as const,
    }));
    if (prefRows.length > 0) {
      await supabase.from("user_word_state").upsert(prefRows, { onConflict: "user_id,word", ignoreDuplicates: false });
    }

    await supabase.from("study_chunks").delete().eq("user_id", user.id).eq("episode_id", episodeId);

    const chunks: VocabItem[][] = [];
    for (let i = 0; i < kept.length; i += CHUNK_SIZE) chunks.push(kept.slice(i, i + CHUNK_SIZE));

    for (let idx = 0; idx < chunks.length; idx++) {
      const { data: chunk, error: cErr } = await supabase
        .from("study_chunks")
        .insert({ user_id: user.id, episode_id: episodeId, chunk_index: idx + 1, word_count: chunks[idx].length })
        .select("id").single();
      if (cErr || !chunk) { toast.error("Failed to create chunk"); setCreating(false); return; }
      const wordRows = chunks[idx].map((v, pos) => ({
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
      if (wErr) { toast.error("Failed to save chunk words"); setCreating(false); return; }
    }

    toast.success(`Created ${chunks.length} chunk${chunks.length === 1 ? "" : "s"}`);
    navigate(`/episode/${episodeId}`);
  };

  if (loading) {
    return <div className="min-h-[60vh] grid place-items-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const counts = vocab.reduce(
    (acc, v) => { acc[modes[v.word] ?? "study"]++; return acc; },
    { study: 0, kanji_only: 0, skip: 0 } as Record<Mode, number>,
  );

  return (
    <div className="max-w-2xl mx-auto px-5 pt-4 pb-36">
      <div className="flex items-center justify-between mb-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}><ChevronLeft className="h-5 w-5" /></Button>
        <div className="text-sm text-muted-foreground">Pre-review</div>
        <div className="w-9" />
      </div>

      <h1 className="text-xl font-bold mb-1">Choose what to study</h1>
      <p className="text-sm text-muted-foreground mb-3">For each word, pick one option:</p>
      <div className="grid gap-1.5 mb-4 text-xs">
        <div className="flex items-start gap-2"><BookOpen className="h-3.5 w-3.5 mt-0.5 text-primary shrink-0" /><span><span className="font-medium text-foreground">Study</span> — learn reading, meaning, and kanji.</span></div>
        <div className="flex items-start gap-2"><Type className="h-3.5 w-3.5 mt-0.5 text-primary shrink-0" /><span><span className="font-medium text-foreground">Kanji only</span> — you know the word, just learn its kanji form.</span></div>
        <div className="flex items-start gap-2"><X className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" /><span><span className="font-medium text-foreground">Skip</span> — already know it, leave it out.</span></div>
      </div>

      {vocab.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          Nothing to pre-review — you've already mastered everything in this episode.
        </Card>
      ) : (
        <div className="grid gap-2 mb-4">
          {vocab.map((v) => {
            const mode = modes[v.word] ?? "study";
            const hasKanji = v.word !== v.reading;
            return (
              <Card
                key={v.word}
                className={cn(
                  "p-3 gradient-card border-border/50 transition",
                  mode === "skip" && "opacity-50",
                )}
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-jp text-base truncate">
                      {v.word} <span className="text-muted-foreground text-xs">{v.reading}</span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{v.meaning}</div>
                  </div>
                  <Badge variant="secondary" className="text-[10px] shrink-0">{v.jlpt_level}</Badge>
                </div>
                <div className="grid grid-cols-3 gap-1 rounded-md bg-muted/40 p-1">
                  <ModeBtn active={mode === "study"} onClick={() => setMode(v.word, "study")} icon={<BookOpen className="h-3.5 w-3.5" />} label="Study" />
                  <ModeBtn
                    active={mode === "kanji_only"}
                    onClick={() => hasKanji && setMode(v.word, "kanji_only")}
                    icon={<Type className="h-3.5 w-3.5" />}
                    label="Kanji only"
                    disabled={!hasKanji}
                  />
                  <ModeBtn active={mode === "skip"} onClick={() => setMode(v.word, "skip")} icon={<X className="h-3.5 w-3.5" />} label="Skip" />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-background/95 backdrop-blur border-t border-border">
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-3">
          <div className="text-sm">
            <div className="font-medium flex items-center gap-1.5"><Layers className="h-4 w-4 text-primary" /> {kept.length} word{kept.length === 1 ? "" : "s"}</div>
            <div className="text-xs text-muted-foreground">
              {counts.study} study · {counts.kanji_only} kanji · {counts.skip} skip → {chunkCount} chunk{chunkCount === 1 ? "" : "s"}
            </div>
          </div>
          <Button
            className="gradient-primary text-primary-foreground h-12 px-6"
            onClick={createChunks}
            disabled={creating || kept.length === 0}
          >
            {creating ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</> : "Create chunks"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ModeBtn({
  active, onClick, icon, label, disabled,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium transition",
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground hover:bg-background/60",
        disabled && "opacity-40 cursor-not-allowed hover:bg-transparent hover:text-muted-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

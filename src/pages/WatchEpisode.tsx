import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, Shuffle, Eye, EyeOff, Trophy, Languages } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/i18n";
import { formatLevel } from "@/lib/languages";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type VocabItem = {
  word: string;
  reading: string;
  meaning: string;
  jlpt_level: string;
  level?: string;
};

type BoardWord = VocabItem & { hit: boolean; free?: boolean };

const SIZES = [3, 4, 5] as const;
type Size = typeof SIZES[number];

// Pick N random items from array
function sample<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// Check if a board has any winning line
function getWinningLines(board: BoardWord[], size: Size): number[][] {
  const idx = (r: number, c: number) => r * size + c;
  const lines: number[][] = [];
  for (let r = 0; r < size; r++) lines.push(Array.from({ length: size }, (_, c) => idx(r, c)));
  for (let c = 0; c < size; c++) lines.push(Array.from({ length: size }, (_, r) => idx(r, c)));
  lines.push(Array.from({ length: size }, (_, i) => idx(i, i)));
  lines.push(Array.from({ length: size }, (_, i) => idx(i, size - 1 - i)));
  return lines.filter(line => line.every(i => board[i]?.hit));
}

export default function WatchEpisode() {
  const { episodeId } = useParams();
  const navigate = useNavigate();
  const { user, learningLanguage, learningLanguageInfo } = useAuth();
  const { t } = useI18n();
  const [episode, setEpisode] = useState<{ episode_number: number } | null>(null);
  const [pool, setPool] = useState<VocabItem[]>([]);
  const [size, setSize] = useState<Size>(4);
  const [board, setBoard] = useState<BoardWord[]>([]);
  const [showReading, setShowReading] = useState(true);
  const [showMeaning, setShowMeaning] = useState(false);
  const [bingoCount, setBingoCount] = useState(0);
  const [loading, setLoading] = useState(true);

  // Load eligible words: episode vocab ∩ user's learning/not-too-easy words
  useEffect(() => {
    (async () => {
      if (!episodeId || !user) return;
      setLoading(true);
      // Get all chunks the user has studied for this episode, then their words.
      const [{ data: ep }, { data: cache }, { data: chunks }, { data: words }] = await Promise.all([
        supabase.from("episodes").select("episode_number").eq("id", episodeId).maybeSingle(),
        supabase.from("episode_vocab_cache").select("vocab").eq("episode_id", episodeId).maybeSingle(),
        supabase.from("study_chunks").select("id").eq("episode_id", episodeId).eq("user_id", user.id).not("studied_at", "is", null),
        supabase.from("user_word_state").select("word,state,correct_streak,preference").eq("user_id", user.id).eq("learning_language", learningLanguage),
      ]);
      setEpisode(ep as any);
      const epVocab = ((cache?.vocab ?? []) as VocabItem[]);
      const chunkIds = (chunks ?? []).map((c: any) => c.id);
      let studiedWordsSet = new Set<string>();
      if (chunkIds.length > 0) {
        const { data: chunkWords } = await supabase
          .from("study_chunk_words")
          .select("word")
          .in("chunk_id", chunkIds);
        (chunkWords ?? []).forEach((w: any) => studiedWordsSet.add(w.word));
      }
      const stateMap = new Map<string, { state: string; correct_streak: number; preference: string }>();
      (words ?? []).forEach((w: any) => stateMap.set(w.word, w));
      // Eligible = words actually studied in a chunk for THIS episode,
      // still in "learning" or "known" with streak < 3. Exclude "skip".
      const eligible = epVocab.filter(v => {
        if (!studiedWordsSet.has(v.word)) return false;
        const s = stateMap.get(v.word);
        if (!s) return false;
        if (s.preference === "skip") return false;
        if (s.state === "learning") return true;
        if (s.state === "known" && (s.correct_streak ?? 0) < 3) return true;
        return false;
      });
      setPool(eligible);
      setLoading(false);
    })();
  }, [episodeId, user, learningLanguage]);

  // Generate board whenever pool or size changes
  useEffect(() => {
    if (pool.length === 0) { setBoard([]); return; }
    generateBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, size]);

  const generateBoard = () => {
    const total = size * size;
    const center = size % 2 === 1 ? Math.floor(total / 2) : -1;
    const needed = center >= 0 ? total - 1 : total;
    if (pool.length < needed) {
      // Allow duplicates if pool too small (rare); pad with repeats
      const padded: VocabItem[] = [];
      while (padded.length < needed) padded.push(...sample(pool, Math.min(pool.length, needed - padded.length)));
      const tiles: BoardWord[] = [];
      let pi = 0;
      for (let i = 0; i < total; i++) {
        if (i === center) tiles.push({ word: "★", reading: t("watch.free"), meaning: "", jlpt_level: "", hit: true, free: true });
        else tiles.push({ ...padded[pi++], hit: false });
      }
      setBoard(tiles);
    } else {
      const picked = sample(pool, needed);
      const tiles: BoardWord[] = [];
      let pi = 0;
      for (let i = 0; i < total; i++) {
        if (i === center) tiles.push({ word: "★", reading: t("watch.free"), meaning: "", jlpt_level: "", hit: true, free: true });
        else tiles.push({ ...picked[pi++], hit: false });
      }
      setBoard(tiles);
    }
    setBingoCount(0);
  };

  const toggleTile = (i: number) => {
    setBoard(prev => {
      const next = [...prev];
      if (next[i].free) return next;
      next[i] = { ...next[i], hit: !next[i].hit };
      const wins = getWinningLines(next, size);
      if (wins.length > bingoCount) {
        toast.success(t("watch.bingoToastTitle"), { description: t("watch.bingoToastDesc", { n: wins.length }) });
        setBingoCount(wins.length);
      } else if (wins.length < bingoCount) {
        setBingoCount(wins.length);
      }
      return next;
    });
  };

  const winningSet = useMemo(() => {
    const lines = getWinningLines(board, size);
    return new Set(lines.flat());
  }, [board, size]);

  const hitCount = board.filter(b => b.hit && !b.free).length;
  const totalNonFree = board.filter(b => !b.free).length;

  return (
    <div className="max-w-2xl mx-auto px-4 pt-4 pb-10 min-w-0">
      <div className="flex items-center justify-between mb-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}><ChevronLeft className="h-5 w-5" /></Button>
        <div className="text-sm text-muted-foreground">{t("watch.title", { n: episode?.episode_number ?? "" })}</div>
        <div className="w-9" />
      </div>

      <Card className="p-4 mb-4 gradient-card border-border/50">
        <div className="flex items-center gap-2 mb-2">
          <Trophy className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">{t("watch.bingo")}</h1>
          {bingoCount > 0 && <Badge className="ml-auto gradient-primary text-primary-foreground">{bingoCount} {t("watch.bingo")}</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">{t("watch.bingoDesc")}</p>
      </Card>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex rounded-md border border-border overflow-hidden">
          {SIZES.map(s => (
            <button
              key={s}
              onClick={() => setSize(s)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium transition-colors",
                size === s ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {s}×{s}
            </button>
          ))}
        </div>
        <Button size="sm" variant="outline" className="h-8" onClick={generateBoard} disabled={pool.length === 0}>
          <Shuffle className="h-3.5 w-3.5" /> {t("watch.newBoard")}
        </Button>
        <Button size="sm" variant={showReading ? "default" : "outline"} className="h-8" onClick={() => setShowReading(v => !v)}>
          <Languages className="h-3.5 w-3.5" /> {t("watch.reading")}
        </Button>
        <Button size="sm" variant={showMeaning ? "default" : "outline"} className="h-8" onClick={() => setShowMeaning(v => !v)}>
          {showMeaning ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />} {t("watch.meaning")}
        </Button>
      </div>

      {loading ? (
        <Card className="p-6 text-center text-sm text-muted-foreground gradient-card border-border/50">{t("common.loading")}</Card>
      ) : pool.length === 0 ? (
        <Card className="p-6 text-center gradient-card border-border/50">
          <h2 className="font-semibold mb-1">{t("watch.noEligibleTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("watch.noEligibleBody")}</p>
        </Card>
      ) : (
        <>
          <div
            className="grid gap-1.5 mb-3 w-full"
            style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
          >
            {board.map((tile, i) => {
              const isWinning = winningSet.has(i);
              return (
                <button
                  key={i}
                  onClick={() => toggleTile(i)}
                  className={cn(
                    "aspect-square rounded-md border p-1 flex flex-col items-center justify-center text-center transition-all min-w-0 overflow-hidden",
                    tile.free
                      ? "bg-primary/20 border-primary/40 text-primary"
                      : tile.hit
                        ? "bg-success/20 border-success/60"
                        : "bg-card border-border hover:border-primary/40",
                    isWinning && !tile.free && "ring-2 ring-primary",
                  )}
                >
                  {tile.free ? (
                    <span className="text-2xl">★</span>
                  ) : (
                    <>
                      <div className={cn("font-semibold leading-tight break-all", learningLanguageInfo.hasRuby && "font-jp")} style={{ fontSize: size === 5 ? "0.7rem" : size === 4 ? "0.85rem" : "1rem" }}>
                        {tile.word}
                      </div>
                      {learningLanguageInfo.hasRuby && showReading && tile.reading && tile.reading !== tile.word && (
                        <div className="text-muted-foreground leading-tight break-all" style={{ fontSize: size === 5 ? "0.55rem" : "0.65rem" }}>
                          {tile.reading}
                        </div>
                      )}
                      {showMeaning && tile.meaning && (
                        <div className="text-muted-foreground leading-tight line-clamp-2 mt-0.5" style={{ fontSize: size === 5 ? "0.5rem" : "0.6rem" }}>
                          {tile.meaning}
                        </div>
                      )}
                    </>
                  )}
                </button>
              );
            })}
          </div>
          <div className="text-xs text-muted-foreground text-center">
            {t("watch.heardStats", { hit: hitCount, total: totalNonFree, n: pool.length })}
          </div>
        </>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, Loader2, Upload, Sparkles, BookOpen, BrainCircuit, Volume2, Plus, Mic, Layers, Check, Type, CheckCircle2, RotateCw, Tv, GraduationCap, Repeat } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { TutorChat } from "@/components/TutorChat";
import { EpisodeSummary } from "@/components/EpisodeSummary";
import { EpisodeDiscussion } from "@/components/EpisodeDiscussion";
import { cn } from "@/lib/utils";
import { useStudyPrefs } from "@/hooks/use-study-prefs";
import { useI18n } from "@/i18n";
import { levelRank, scaleLabel, formatLevel } from "@/lib/languages";

const TTS_LANG: Record<string, string> = { ja: "ja-JP", es: "es-ES", fr: "fr-FR", de: "de-DE" };
const ttsLangFor = (code: string) => TTS_LANG[code] ?? "en-US";

// SRS intervals in days (Leitner-style). Index = srs_level.
const SRS_INTERVALS_DAYS = [1, 3, 7, 14, 30, 60, 120, 240, 480];
const dueAtForLevel = (level: number) => {
  const days = SRS_INTERVALS_DAYS[Math.min(level, SRS_INTERVALS_DAYS.length - 1)];
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
};

type VocabItem = {
  word: string;
  reading: string;
  meaning: string;
  part_of_speech: string;
  jlpt_level?: string;
  level?: string;
  example_sentence_jp: string;
  example_sentence_en: string;
  frequency?: number;
};
type SentenceItem = { jp: string; en: string };
type WordPref = "study" | "kanji_only" | "skip";
type WordState = "unknown" | "learning" | "known";
type KnownSource = "prior" | "learned" | null;
type WordRow = { word: string; state: WordState; preference: WordPref; known_source: KnownSource; srs_level: number; srs_due_at: string | null };

export default function EpisodeDetail() {
  const { episodeId } = useParams();
  const navigate = useNavigate();
  const { user, learningLanguage, learningLanguageInfo, progress } = useAuth();
  const { t } = useI18n();
  const { chunkSize: CHUNK_SIZE, queueSize: QUEUE_SIZE } = useStudyPrefs();
  const pollRef = useRef<number | null>(null);
  const [episode, setEpisode] = useState<{ id: string; episode_number: number; processing_status: string; processing_chunks_total: number; processing_chunks_done: number } | null>(null);
  const [vocab, setVocab] = useState<VocabItem[]>([]);
  const [sentences, setSentences] = useState<SentenceItem[]>([]);
  const [wordStates, setWordStates] = useState<Map<string, WordRow>>(new Map());
  const [studiedWords, setStudiedWords] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progressStage, setProgressStage] = useState<string>("");
  const [showAll, setShowAll] = useState(false);
  const [showKnown, setShowKnown] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [chunks, setChunks] = useState<{ id: string; chunk_index: number; word_count: number; studied_at: string | null }[]>([]);
  const [chunkifying, setChunkifying] = useState(false);
  const [allQuery, setAllQuery] = useState("");
  const [knownQuery, setKnownQuery] = useState("");

  const getLevel = (v: VocabItem) => v.level ?? v.jlpt_level ?? "none";

  const matchesQuery = (v: VocabItem, q: string) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return (
      v.word.toLowerCase().includes(needle) ||
      (v.reading ?? "").toLowerCase().includes(needle) ||
      (v.meaning ?? "").toLowerCase().includes(needle)
    );
  };

  const load = async () => {
    if (!episodeId || !user) return;
    const { data: ep } = await supabase.from("episodes").select("id,episode_number,processing_status,processing_chunks_total,processing_chunks_done").eq("id", episodeId).maybeSingle();
    setEpisode(ep as any);
    const { data: cache } = await supabase.from("episode_vocab_cache").select("vocab,sentences").eq("episode_id", episodeId).maybeSingle();
    setVocab(((cache?.vocab ?? []) as VocabItem[]));
    setSentences(((cache?.sentences ?? []) as SentenceItem[]));
    const { data: words } = await supabase.from("user_word_state").select("word,state,preference,known_source,srs_level,srs_due_at").eq("user_id", user.id).eq("learning_language", learningLanguage);
    const map = new Map<string, WordRow>();
    (words ?? []).forEach((w: any) => map.set(w.word, {
      word: w.word, state: w.state, preference: w.preference,
      known_source: (w.known_source ?? null) as KnownSource,
      srs_level: w.srs_level ?? 0,
      srs_due_at: w.srs_due_at ?? null,
    }));
    setWordStates(map);
    // Words seen in any quiz OR any studied chunk → "Known" defaults to SRS-tracked.
    const [{ data: quizzed }, { data: studiedChunks }] = await Promise.all([
      supabase.from("quiz_results").select("word").eq("user_id", user.id),
      supabase.from("study_chunks").select("id").eq("user_id", user.id).not("studied_at", "is", null),
    ]);
    const studiedSet = new Set<string>((quizzed ?? []).map((r: any) => r.word));
    const chunkIds = (studiedChunks ?? []).map((c: any) => c.id);
    if (chunkIds.length > 0) {
      const { data: chunkWords } = await supabase
        .from("study_chunk_words")
        .select("word")
        .in("chunk_id", chunkIds);
      (chunkWords ?? []).forEach((r: any) => studiedSet.add(r.word));
    }
    setStudiedWords(studiedSet);
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
      setProgressStage(t("episode.extracting"));
      pollRef.current = window.setInterval(async () => {
        const ep = await load();
        if ((ep as any)?.processing_status === "ready") {
          if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
          setBusy(false); setProgressStage("");
          toast.success(t("episode.processed"));
        } else if ((ep as any)?.processing_status === "failed") {
          if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
          setBusy(false); setProgressStage("");
          toast.error(t("episode.processFailed"), { description: t("episode.tryAgain") });
        }
      }, 3000);
    }
  }, [episode?.processing_status]);

  const startProcess = async (subText: string) => {
    if (!episodeId) return;
    setBusy(true);
    setProgressStage(t("episode.sendingSubs"));
    const { data, error } = await supabase.functions.invoke("process-episode", {
      body: { episode_id: episodeId, subtitle_text: subText },
    });
    if (error) { setBusy(false); setProgressStage(""); toast.error(t("episode.processFailed"), { description: error.message }); return; }
    if ((data as any)?.error) { setBusy(false); setProgressStage(""); toast.error(t("episode.processFailed"), { description: (data as any).error }); return; }
    if ((data as any)?.cached) {
      setBusy(false); setProgressStage("");
      toast.success(t("episode.loadedFromCache"));
      load();
      return;
    }
    setProgressStage(t("episode.extractingLong"));
    await load();
  };

  const tryAutoFetch = async () => {
    if (!episodeId) return;
    setBusy(true);
    setProgressStage(t("episode.fetchingSubs"));
    const { data, error } = await supabase.functions.invoke("fetch-subtitles", { body: { episode_id: episodeId } });
    if (error) { setBusy(false); setProgressStage(""); toast.error(t("episode.fetchFailed"), { description: error.message }); return; }
    if (!data?.found) {
      setBusy(false); setProgressStage("");
      toast.error(t("episode.noSubsFound"), { description: t("episode.tryAgainLater") });
      return;
    }
    await startProcess(data.content);
  };

  const speak = (text: string) => {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = ttsLangFor(learningLanguage);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  };

  // Level-based defaulting: words below the user's level default to "known" unless user overrode.
  const myRank = levelRank(learningLanguage, progress?.level);
  const isBelowLevel = (lvl: string) => myRank > 0 && (levelRank(learningLanguage, lvl) || 99) < myRank;

  // Effective bucket for a word: "known" | "new" (with preference)
  const bucketOf = (v: VocabItem): "known" | "new" => {
    const s = wordStates.get(v.word);
    if (s?.state === "known") return "known";
    if (s) return "new"; // user explicitly set it as not-known
    if (isBelowLevel(getLevel(v))) return "known"; // auto-skip default
    return "new";
  };

  const prefOf = (word: string): WordPref => wordStates.get(word)?.preference ?? "study";

  // Importance score: how central is this word to the episode's story.
  // Signals: (a) how often it appears across the AI-extracted example sentences for THIS episode,
  // (b) level commonness (lower/easier level = more common word = more likely to recur).
  // Higher = more important.
  const levelCommonness = (lvl: string) => {
    const rank = levelRank(learningLanguage, lvl);
    if (!rank) return 0;
    const total = 6;
    return Math.max(0, total - rank);
  };
  const { importance, frequency } = useMemo(() => {
    const corpus = [
      ...vocab.flatMap(v => [v.example_sentence_jp ?? ""]),
      ...sentences.map(s => s.jp ?? ""),
    ].join("\n");
    const score = new Map<string, number>();
    const freqMap = new Map<string, number>();
    for (const v of vocab) {
      // Prefer the tokenizer's true subtitle frequency; fall back to corpus regex match
      // for older cached entries that don't carry `frequency`.
      let freq = typeof v.frequency === "number" ? v.frequency : 0;
      if (!freq) {
        const w = v.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (w) {
          const re = new RegExp(w, "g");
          freq = (corpus.match(re) ?? []).length;
        }
      }
      freqMap.set(v.word, freq);
      score.set(v.word, freq * 10 + levelCommonness(getLevel(v)));
    }
    return { importance: score, frequency: freqMap };
  }, [vocab, sentences]);

  const byImportance = (a: VocabItem, b: VocabItem) =>
    (importance.get(b.word) ?? 0) - (importance.get(a.word) ?? 0);

  const sortedVocab = useMemo(() => [...vocab].sort(byImportance), [vocab, importance]);
  const newVocab = useMemo(() => sortedVocab.filter(v => bucketOf(v) === "new"), [sortedVocab, wordStates, myRank]);
  const knownVocab = useMemo(() => sortedVocab.filter(v => bucketOf(v) === "known"), [sortedVocab, wordStates, myRank]);
  // Queue = up to QUEUE_SIZE most-important words to learn next (study/kanji_only preference, not skipped).
  const queueVocab = useMemo(
    () => newVocab.filter(v => prefOf(v.word) !== "skip").slice(0, QUEUE_SIZE),
    [newVocab, wordStates]
  );

  // Chunkify-staleness: chunks reflect the current "to learn" queue (max QUEUE_SIZE words).
  const studyableCount = queueVocab.length;
  const chunkedCount = chunks.reduce((s, c) => s + c.word_count, 0);
  const chunksStale = chunks.length > 0 && chunkedCount !== studyableCount;

  const upsertWord = async (
    v: VocabItem,
    patch: Partial<Pick<WordRow, "state" | "preference" | "known_source" | "srs_level" | "srs_due_at">>,
    extra?: { marked_known_at?: string | null }
  ) => {
    if (!user) return;
    const prev = wordStates.get(v.word);
    const next: WordRow = {
      word: v.word,
      state: (patch.state ?? prev?.state ?? "unknown") as WordState,
      preference: (patch.preference ?? prev?.preference ?? "study") as WordPref,
      known_source: (patch.known_source !== undefined ? patch.known_source : (prev?.known_source ?? null)) as KnownSource,
      srs_level: patch.srs_level ?? prev?.srs_level ?? 0,
      srs_due_at: patch.srs_due_at !== undefined ? patch.srs_due_at : (prev?.srs_due_at ?? null),
    };
    setWordStates(m => {
      const nm = new Map(m);
      nm.set(v.word, next);
      return nm;
    });
    const payload: any = {
      user_id: user.id,
      word: v.word,
      reading: v.reading,
      level: getLevel(v) === "none" ? null : getLevel(v),
      learning_language: learningLanguage,
      state: next.state,
      preference: next.preference,
      known_source: next.known_source,
      srs_level: next.srs_level,
      srs_due_at: next.srs_due_at,
    };
    if (extra?.marked_known_at !== undefined) payload.marked_known_at = extra.marked_known_at;
    const { error: upsertErr } = await supabase.from("user_word_state").upsert(payload, { onConflict: "user_id,word,learning_language" });
    if (upsertErr) console.error("user_word_state upsert failed:", upsertErr, payload);
  };

  // Default "Known" action = "Learned it" (SRS-tracked, will resurface in future episodes).
  const markKnownLearned = (v: VocabItem) =>
    upsertWord(v, { state: "known", known_source: "learned", srs_level: 0, srs_due_at: dueAtForLevel(0) }, { marked_known_at: new Date().toISOString() });
  // "Already knew it" = permanent, never resurfaces.
  const markKnownPrior = (v: VocabItem) =>
    upsertWord(v, { state: "known", known_source: "prior", srs_level: 0, srs_due_at: null }, { marked_known_at: new Date().toISOString() });
  const markNew = (v: VocabItem) =>
    upsertWord(v, { state: "unknown", known_source: null, srs_due_at: null });
  // (kanji-only feature removed)

  // Demote any "learned" known word that's now due back into the "learning" queue,
  // bumping its SRS level. "prior" words are never demoted.
  const demoteDueWords = async (words: VocabItem[]): Promise<number> => {
    if (!user || words.length === 0) return 0;
    const now = Date.now();
    const due = words.filter(v => {
      const s = wordStates.get(v.word);
      if (!s || s.state !== "known" || s.known_source !== "learned") return false;
      if (!s.srs_due_at) return false;
      return new Date(s.srs_due_at).getTime() <= now;
    });
    if (due.length === 0) return 0;
    const updates = due.map(v => {
      const s = wordStates.get(v.word)!;
      const newLevel = Math.min(s.srs_level + 1, SRS_INTERVALS_DAYS.length - 1);
      return {
        user_id: user.id,
        word: v.word,
        reading: v.reading,
        level: getLevel(v) === "none" ? null : getLevel(v),
        learning_language: learningLanguage,
        state: "learning" as WordState,
        preference: s.preference,
        known_source: "learned" as KnownSource,
        srs_level: newLevel,
        srs_due_at: dueAtForLevel(newLevel),
        correct_streak: 0,
      };
    });
    await supabase.from("user_word_state").upsert(updates as any, { onConflict: "user_id,word,learning_language" });
    setWordStates(m => {
      const nm = new Map(m);
      for (const u of updates) {
        const prev = nm.get(u.word);
        nm.set(u.word, {
          word: u.word,
          state: u.state,
          preference: u.preference,
          known_source: u.known_source,
          srs_level: u.srs_level,
          srs_due_at: u.srs_due_at,
        });
      }
      return nm;
    });
    return due.length;
  };

  // Manual rewatch: re-evaluate this episode's vocab right now.
  const [rewatching, setRewatching] = useState(false);
  const handleRewatch = async () => {
    setRewatching(true);
    const n = await demoteDueWords(vocab);
    setRewatching(false);
    if (n > 0) toast.success(t("episode.wordsBackInQueue", { n }));
    else toast.message(t("episode.nothingDueYet"), { description: t("episode.nothingDueBody") });
  };

  // Auto-demote on first open: only if user has never created chunks for this episode
  // (i.e. truly first time viewing). This keeps already-opened episodes stable.
  const autoDemoteRanRef = useRef(false);
  useEffect(() => {
    if (autoDemoteRanRef.current) return;
    if (!user || vocab.length === 0) return;
    if (chunks.length > 0) { autoDemoteRanRef.current = true; return; }
    autoDemoteRanRef.current = true;
    demoteDueWords(vocab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vocab, chunks, user]);

  const chunkify = async () => {
    if (!user || !episodeId) return;
    const studyable = queueVocab;
    if (studyable.length === 0) {
      toast.error(t("episode.noWordsToChunkify"));
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
      if (cErr || !chunk) { toast.error(t("episode.chunkCreateFailed")); setChunkifying(false); return; }
      const wordRows = groups[idx].map((v, pos) => ({
        chunk_id: chunk.id,
        word: v.word,
        reading: v.reading,
        meaning: v.meaning,
        level: getLevel(v) === "none" ? null : getLevel(v),
        part_of_speech: v.part_of_speech,
        example_sentence_jp: v.example_sentence_jp,
        example_sentence_en: v.example_sentence_en,
        position: pos,
      }));
      const { error: wErr } = await supabase.from("study_chunk_words").insert(wordRows);
      if (wErr) { toast.error(t("episode.chunkWordsFailed")); setChunkifying(false); return; }
    }
    toast.success(t("episode.chunksCreated", { n: groups.length }));
    setChunkifying(false);
    await load();
  };

  return (
    <div className="max-w-2xl mx-auto px-5 pt-4 pb-10">
      <div className="flex items-center justify-between mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}><ChevronLeft className="h-5 w-5" /></Button>
        <div className="text-sm text-muted-foreground">{t("episode.number", { n: episode?.episode_number ?? "" })}</div>
        {vocab.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 px-2 text-xs gap-1"
            onClick={handleRewatch}
            disabled={rewatching}
            title={t("episode.rewatchHint")}
          >
            {rewatching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Repeat className="h-4 w-4" />}
            {t("episode.rewatch")}
          </Button>
        ) : (
          <div className="w-9" />
        )}
      </div>

      {vocab.length === 0 ? (
        <Card className="p-6 text-center gradient-card border-border/50 shadow-card">
          <Sparkles className="h-10 w-10 mx-auto text-primary mb-3" />
          <h2 className="text-lg font-semibold mb-1">
            {busy ? t("episode.processing") : t("episode.processThis")}
          </h2>
          <p className="text-sm text-muted-foreground mb-5">
            {busy
              ? (progressStage || t("episode.workingOnIt"))
              : t("episode.autoFetchExplain")}
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
                    ? t("episode.processedChunks", { done, total, pct })
                    : t("episode.leavePage")}
                </p>
              </div>
            );
          })()}
          <div className="grid gap-2">
            <Button onClick={tryAutoFetch} disabled={busy} className="gradient-primary text-primary-foreground h-12">
              {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> {t("episode.workingEllipsis")}</> : <><Sparkles className="h-4 w-4" /> {t("episode.autoFetchProcess")}</>}
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 mb-4">
            <StatBox
              label={t("episode.toLearn")}
              value={`${queueVocab.length}/${newVocab.length}`}
              accent="text-primary"
              active={showQueue}
              onClick={() => { setShowQueue(s => !s); setShowAll(false); setShowKnown(false); }}
            />
            <StatBox
              label={t("episode.known")}
              value={knownVocab.length}
              accent="text-success"
              active={showKnown}
              onClick={() => { setShowKnown(s => !s); setShowAll(false); setShowQueue(false); }}
            />
            <StatBox
              label={t("episode.all")}
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
                  {t("episode.toLearnNext", { n: queueVocab.length })}
                  {newVocab.length > QUEUE_SIZE && (
                    <span className="ml-1 normal-case tracking-normal text-muted-foreground/70">· {t("episode.moreQueued", { n: newVocab.length - QUEUE_SIZE })}</span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground/80 flex items-center gap-2">
                  <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />{t("episode.known").toLowerCase()}</span>
                </div>
              </div>
              {queueVocab.length === 0 ? (
                <div className="text-sm text-muted-foreground">{t("episode.queueEmpty")}</div>
              ) : (
                <div className="grid gap-1 max-h-96 overflow-y-auto">
                  {queueVocab.map((v) => renderQueueRow(v, studiedWords.has(v.word) ? markKnownLearned : markKnownPrior, frequency.get(v.word) ?? 0, t, learningLanguageInfo.hasRuby))}
                </div>
              )}
            </Card>
          )}

          {showAll && (
            <Card className="p-3 mb-4 gradient-card border-border/50">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">{t("episode.allWords", { n: vocab.length })}</div>
              <Input
                value={allQuery}
                onChange={(e) => setAllQuery(e.target.value)}
                placeholder={t("episode.searchPlaceholder")}
                className="h-8 mb-2"
              />
              <div className="grid gap-1 max-h-96 overflow-y-auto">
                {sortedVocab.filter((v) => matchesQuery(v, allQuery)).map((v) => {
                  const bucket = bucketOf(v);
                  return (
                    <div key={`${v.word}-${v.reading}`} className="flex items-start gap-2 py-1.5 border-b border-border/30 last:border-0">
                      <div className="min-w-0 flex-1">
                        <div className={cn("text-sm truncate", learningLanguageInfo.hasRuby && "font-jp")}>
                          {v.word} {learningLanguageInfo.hasRuby && <span className="text-muted-foreground text-xs">{v.reading}</span>}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">{v.meaning}</div>
                        <div className="flex items-center gap-1.5 mt-1">
                          <FreqBadge freq={frequency.get(v.word) ?? 0} title={t("episode.appearsN", { n: frequency.get(v.word) ?? 0 })} />
                          <Badge variant="secondary" className="text-[10px] shrink-0">{formatLevel(v.level ?? v.jlpt_level)}</Badge>
                        </div>
                      </div>
                      {bucket === "known" ? (
                        <Button size="sm" variant="ghost" className="h-7 px-2 shrink-0" onClick={() => markNew(v)}>
                          <Plus className="h-3 w-3" /> {t("episode.new")}
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" className="h-7 px-2 shrink-0 hover:text-success" onClick={() => markKnownLearned(v)}>
                          <CheckCircle2 className="h-3 w-3" /> {t("episode.known")}
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
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">{t("episode.knownWords", { n: knownVocab.length })}</div>
              {knownVocab.length === 0 ? (
                <div className="text-sm text-muted-foreground">{t("episode.noKnownYet")}</div>
              ) : (
                <>
                  <Input
                    value={knownQuery}
                    onChange={(e) => setKnownQuery(e.target.value)}
                    placeholder={t("episode.searchPlaceholder")}
                    className="h-8 mb-2"
                  />
                  <div className="grid gap-1 max-h-96 overflow-y-auto">
                    {knownVocab.filter((v) => matchesQuery(v, knownQuery)).map((v) => {
                      const s = wordStates.get(v.word);
                      const reason = s?.state === "known" ? t("episode.reasonKnown") : t("episode.reasonBelowLevel");
                      return (
                        <div key={`${v.word}-${v.reading}`} className="flex items-start gap-2 py-1.5 border-b border-border/30 last:border-0">
                          <div className="min-w-0 flex-1">
                            <div className={cn("text-sm truncate", learningLanguageInfo.hasRuby && "font-jp")}>
                              {v.word} {learningLanguageInfo.hasRuby && <span className="text-muted-foreground text-xs">{v.reading}</span>}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">{v.meaning}</div>
                            <div className="flex items-center gap-1.5 mt-1">
                              <FreqBadge freq={frequency.get(v.word) ?? 0} title={t("episode.appearsN", { n: frequency.get(v.word) ?? 0 })} />
                              <Badge variant="secondary" className="text-[10px] shrink-0">{formatLevel(v.level ?? v.jlpt_level)}</Badge>
                              <span className="text-[10px] text-muted-foreground/70">{reason}</span>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 shrink-0"
                            onClick={() => markNew(v)}
                            title={t("episode.moveToNew")}
                          >
                            <Plus className="h-3 w-3" /> {t("episode.new")}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </>
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
                {chunkifying ? <><Loader2 className="h-4 w-4 animate-spin" /> {t("episode.creatingChunks")}</> : <><Layers className="h-4 w-4" /> {t("episode.createChunks", { n: studyableCount })}</>}
              </Button>
            ) : (
              <>
                <div className="flex items-center justify-between mb-1">
                  <h3 className="font-semibold flex items-center gap-2">
                    <Layers className="h-4 w-4 text-primary" /> {t("episode.studyChunks")}
                  </h3>
                  <Button
                    size="sm"
                    variant={chunksStale ? "default" : "ghost"}
                    className={cn("h-7 px-2 text-xs", chunksStale && "gradient-primary text-primary-foreground")}
                    onClick={chunkify}
                    disabled={chunkifying || studyableCount === 0}
                  >
                    {chunkifying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
                    {t("episode.rechunkify")}
                  </Button>
                </div>
                {chunksStale && (
                  <div className="text-xs text-accent mb-1">
                    {t("episode.wordListChanged", { now: studyableCount, chunked: chunkedCount })}
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
                          {t("episode.chunkN", { n: c.chunk_index })}
                          {c.studied_at && <Check className="h-3.5 w-3.5 text-success" />}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t("episode.wordCount", { n: c.word_count })}
                          {c.studied_at ? ` · ${t("episode.studied")}` : ` · ${t("episode.notYet")}`}
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
                  <BrainCircuit className="h-4 w-4" /> {t("episode.quizStudiedChunks")}
                </Button>
              </>
            )}
            <Button
              variant="outline"
              className="w-full h-11"
              onClick={() => navigate(`/study/${episodeId}/voice`)}
              disabled={studyableCount === 0}
            >
              <Mic className="h-4 w-4" /> {t("episode.handsFreeVoice")}
            </Button>
            <Button
              variant="outline"
              className="w-full h-11"
              onClick={() => navigate(`/episode/${episodeId}/watch`)}
            >
              <Tv className="h-4 w-4" /> {t("episode.watchModeBingo")}
            </Button>
          </div>

          {episodeId && (
            <EpisodeSummary
              episodeId={episodeId}
              studiedWordCount={chunks.filter(c => c.studied_at).reduce((s, c) => s + c.word_count, 0)}
            />
          )}

          {episodeId && (
            <EpisodeDiscussion
              episodeId={episodeId}
              studiedWordCount={chunks.filter(c => c.studied_at).reduce((s, c) => s + c.word_count, 0)}
            />
          )}

          <h3 className="font-semibold mb-2 flex items-center gap-2"><BrainCircuit className="h-4 w-4 text-primary" /> {t("episode.sentences")}</h3>
          <div className="grid gap-2 mb-6">
            {sentences.slice(0, 8).map((s, i) => (
              <Card key={i} className="p-3 gradient-card border-border/50">
                <div className="flex items-start justify-between gap-2">
                  <div className={cn("text-base flex-1", learningLanguageInfo.hasRuby && "font-jp")}>{s.jp}</div>
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
          next.set(w, {
            word: w,
            state: "known",
            preference: existing?.preference ?? "study",
            known_source: existing?.known_source ?? "learned",
            srs_level: existing?.srs_level ?? 0,
            srs_due_at: existing?.srs_due_at ?? dueAtForLevel(0),
          });
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

function FreqBadge({ freq, title }: { freq: number; title: string }) {
  // Visual heat: 0 = neutral, 1 = subtle, 2 = warm, 3+ = hot.
  const tone =
    freq >= 3 ? "bg-primary/15 text-primary"
    : freq === 2 ? "bg-accent/15 text-accent"
    : freq === 1 ? "bg-muted text-muted-foreground"
    : "bg-muted/50 text-muted-foreground/70";
  return (
    <span
      className={cn("text-[10px] px-1.5 py-0.5 rounded-full shrink-0 tabular-nums", tone)}
      title={title}
    >
      ×{freq}
    </span>
  );
}

function renderQueueRow(
  v: VocabItem,
  markKnown: (v: VocabItem) => void,
  freq: number,
  t: (k: any, vars?: any) => string,
  hasRuby: boolean,
) {
  return (
    <div key={`${v.word}-${v.reading}`} className="flex flex-wrap items-center gap-2 py-2 border-b border-border/30 last:border-0">
      <div className="min-w-0 flex-1">
        <div className={cn("text-sm truncate", hasRuby && "font-jp")}>
          {v.word} {hasRuby && <span className="text-muted-foreground text-xs">{v.reading}</span>}
        </div>
        <div className="text-xs text-muted-foreground truncate">{v.meaning}</div>
      </div>
      <FreqBadge freq={freq} title={t("episode.appearsN", { n: freq })} />
      <Badge variant="secondary" className="text-[10px] shrink-0">{formatLevel(v.level ?? v.jlpt_level)}</Badge>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-[11px] gap-1 shrink-0 hover:text-success"
        onClick={() => markKnown(v)}
        title={t("episode.markAsKnown")}
      >
        <CheckCircle2 className="h-3 w-3" /> {t("episode.known")}
      </Button>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ChevronLeft, Mic, MicOff, Play, Pause, SkipForward, Volume2, RotateCw, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";
import { useI18n } from "@/i18n";
import { levelRank } from "@/lib/languages";
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

type VocabItem = {
  word: string;
  reading: string;
  meaning: string;
  part_of_speech: string;
  jlpt_level?: string;
  level?: string;
  example_sentence_jp: string;
  example_sentence_en: string;
};

type Mode = "review" | "quiz";

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike {
  readonly error?: string;
  readonly message?: string;
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type WindowWithSpeechRecognition = Window & {
  SpeechRecognition?: new () => SpeechRecognitionInstance;
  webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
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

const YES_TOKENS = ["yes", "yeah", "yep", "yup", "ya", "know", "knew", "got", "easy", "correct", "right", "ok", "okay", "sure"];
const NO_TOKENS = ["no", "nope", "nah", "skip", "again", "dunno", "wrong", "pass", "next", "dont", "don"];
const REPEAT_TOKENS = ["repeat", "again"];
const MEANING_TOKENS = ["meaning", "hint", "answer", "show", "translate", "translation"];
const PAUSE_TOKENS = ["pause", "stop", "wait"];
const RESUME_TOKENS = ["resume", "continue"];

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

const tokensOf = (s: string) => normalize(s).split(" ").filter(Boolean);

const meaningVariants = (meaning: string) =>
  meaning.split(/[,/;]| or | and /i).map((s) => normalize(s)).filter(Boolean);

const hasAny = (tokens: string[], keywords: string[]) =>
  tokens.some((tok) => keywords.includes(tok));

const matchesYes = (tokens: string[]) => hasAny(tokens, YES_TOKENS);
const matchesNo = (tokens: string[]) => hasAny(tokens, NO_TOKENS);
const matchesRepeat = (tokens: string[]) => hasAny(tokens, REPEAT_TOKENS);
const matchesMeaning = (tokens: string[]) => hasAny(tokens, MEANING_TOKENS);
const matchesPause = (tokens: string[]) => hasAny(tokens, PAUSE_TOKENS);
const matchesResume = (tokens: string[]) => hasAny(tokens, RESUME_TOKENS);

const KANJI_THRESHOLD = 2;
const getLevel = (v: VocabItem) => v.level ?? v.jlpt_level ?? "none";

export default function VoiceStudySession() {
  const { episodeId } = useParams();
  const navigate = useNavigate();
  const { user, learningLanguage, learningLanguageInfo, progress } = useAuth();
  const { t } = useI18n();

  const [vocab, setVocab] = useState<VocabItem[]>([]);
  const [streaks, setStreaks] = useState<Record<string, number>>({});
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("review");

  const [idx, setIdx] = useState(0);
  const [reviewedKnown, setReviewedKnown] = useState(0);
  const [quizCorrect, setQuizCorrect] = useState(0);
  const [done, setDone] = useState(false);
  const [running, setRunning] = useState(false);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState<string>("");
  const [lastResult, setLastResult] = useState<"known" | "learning" | "correct" | "wrong" | null>(null);
  const [supported, setSupported] = useState<boolean>(true);
  const [permissionDenied, setPermissionDenied] = useState<boolean>(false);
  const [recognitionError, setRecognitionError] = useState<string>("");

  // Refs keeping latest state values inside long-lived SpeechRecognition callbacks
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const runningRef = useRef(false);
  const modeRef = useRef<Mode>("review");
  const idxRef = useRef(0);
  const vocabRef = useRef<VocabItem[]>([]);
  const awaitingRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const reviewedKnownRef = useRef(0);
  const quizCorrectRef = useRef(0);
  const streaksRef = useRef<Record<string, number>>({});
  const doneRef = useRef(false);
  const wordRecordsRef = useRef<Record<string, WordSrsRecord>>({});
  const handleVoiceInputRef = useRef<(transcripts: string[]) => void>(() => {});
  const tRef = useRef(t);

  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { vocabRef.current = vocab; }, [vocab]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { reviewedKnownRef.current = reviewedKnown; }, [reviewedKnown]);
  useEffect(() => { quizCorrectRef.current = quizCorrect; }, [quizCorrect]);
  useEffect(() => { streaksRef.current = streaks; }, [streaks]);
  useEffect(() => { doneRef.current = done; }, [done]);
  useEffect(() => { tRef.current = t; }, [t]);

  const userId = user?.id;

  // ---------- load vocab + session ----------
  useEffect(() => {
    if (!episodeId || !userId) return;
    let cancelled = false;
    (async () => {
      const { data: cache } = await supabase
        .from("episode_vocab_cache")
        .select("vocab")
        .eq("episode_id", episodeId)
        .eq("language", learningLanguage)
        .maybeSingle();
      if (cancelled) return;

      const all = (Array.isArray(cache?.vocab) ? cache.vocab : []) as VocabItem[];
      const epWords = Array.from(new Set(all.map((v) => v.word).filter(Boolean)));

      const { data: stateRows } = epWords.length > 0
        ? await fetchBatchedPages<string, StateDbRow>(epWords, 200, (slice, from, to) =>
            supabase
              .from("user_word_state")
              .select("word,reading,level,state,preference,known_source,correct_streak,srs_level,srs_due_at,last_reviewed_at,marked_known_at")
              .eq("user_id", userId)
              .eq("learning_language", learningLanguage)
              .in("word", slice)
              .order("word", { ascending: true })
              .range(from, to),
          )
        : { data: [] as StateDbRow[] };
      if (cancelled) return;

      const knownSet = new Set<string>();
      const trackedSet = new Set<string>();
      const streakMap: Record<string, number> = {};
      const recordMap: Record<string, WordSrsRecord> = {};

      for (const s of stateRows) {
        trackedSet.add(s.word);
        if (s.state === "known") knownSet.add(s.word);
        streakMap[s.word] = s.correct_streak ?? 0;
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
      streaksRef.current = streakMap;
      setStreaks(streakMap);

      const myRank = levelRank(learningLanguage, progress?.level);
      const isBelowLevel = (lvl: string) => myRank > 0 && (levelRank(learningLanguage, lvl) || 99) < myRank;

      const filtered = all.filter((v) =>
        !knownSet.has(v.word) &&
        (!isBelowLevel(getLevel(v)) || trackedSet.has(v.word)),
      );
      vocabRef.current = filtered;
      setVocab(filtered);

      const { data: sess } = await supabase
        .from("study_sessions")
        .insert({
          user_id: userId,
          episode_id: episodeId,
          mode: "review",
          words_studied: 0,
          words_mastered: 0,
          learning_language: learningLanguage,
        })
        .select("id")
        .single();
      if (!cancelled && sess) {
        sessionIdRef.current = sess.id;
        setSessionId(sess.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [episodeId, userId, progress?.level, learningLanguage]);

  // ---------- speech recognition setup ----------
  useEffect(() => {
    const win = window as WindowWithSpeechRecognition;
    const SR = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!SR) {
      setSupported(false);
      return;
    }
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    r.maxAlternatives = 3;

    r.onstart = () => {
      setListening(true);
    };
    r.onaudiostart = null;
    r.onspeechstart = null;
    r.onspeechend = null;
    r.onresult = (event: SpeechRecognitionEventLike) => {
      const interim: string[] = [];
      const finals: string[] = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        for (let j = 0; j < res.length; j++) {
          const text = normalize(res[j].transcript);
          if (!text) continue;
          (res.isFinal ? finals : interim).push(text);
        }
      }
      const display = finals[0] ?? interim[0];
      if (display) setHeard(display);
      if (finals.length > 0) handleVoiceInputRef.current(finals);
    };
    r.onerror = (e: SpeechRecognitionErrorEventLike) => {
      if (e.error !== "aborted" && e.error !== "no-speech") {
        setRecognitionError(e.error || "recognition-error");
      }
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setPermissionDenied(true);
        setRunning(false);
        runningRef.current = false;
        toast.error(tRef.current("voice.micDeniedToast"));
      }
    };
    r.onend = () => {
      setListening(false);
      if (runningRef.current && awaitingRef.current) {
        setTimeout(() => {
          if (runningRef.current && awaitingRef.current) {
            try {
              r.start();
            } catch {
              // Ignore overlapping restart errors
            }
          }
        }, 300);
      }
    };

    recognitionRef.current = r;
    return () => {
      try {
        r.stop();
      } catch {
        // Ignore stop errors on unmount
      }
      recognitionRef.current = null;
    };
  }, []);

  const startRecognition = () => {
    const r = recognitionRef.current;
    if (!r) return;
    setRecognitionError("");
    try {
      r.start();
    } catch {
      // Ignore duplicate start calls
    }
  };

  const stopRecognition = () => {
    const r = recognitionRef.current;
    if (!r) return;
    try {
      r.abort();
    } catch {
      // Ignore abort errors when inactive
    }
    setListening(false);
  };

  // ---------- TTS ----------
  const speak = (text: string, lang = ttsLangFor(learningLanguage), rate = 0.95) =>
    new Promise<void>((resolve) => {
      if (!("speechSynthesis" in window) || !text.trim()) {
        resolve();
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = rate;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    });

  const card = vocab[idx];
  const showKanji = card ? ((streaks[card.word] ?? 0) >= KANJI_THRESHOLD || card.word === card.reading) : false;

  const showKanjiFor = (c: VocabItem) =>
    learningLanguageInfo.hasRuby && ((streaksRef.current[c.word] ?? 0) >= KANJI_THRESHOLD || c.word === c.reading);

  const spokenTargetFor = (c: VocabItem) => {
    if (!learningLanguageInfo.hasRuby) return c.word;
    return (showKanjiFor(c) ? c.word : c.reading) || c.word;
  };

  // ---------- DB write routed through computeNextSrsState ----------
  const recordWord = async (c: VocabItem, gotItRight: boolean) => {
    if (!user) return;
    const lvl = getLevel(c);
    const prev = wordRecordsRef.current[c.word];
    const next = computeNextSrsState(
      prev,
      {
        word: c.word,
        reading: c.reading || null,
        level: lvl === "none" ? null : lvl,
      },
      gotItRight,
    );
    wordRecordsRef.current[c.word] = next;
    streaksRef.current = { ...streaksRef.current, [c.word]: next.correct_streak };
    setStreaks((s) => ({ ...s, [c.word]: next.correct_streak }));

    await supabase.from("user_word_state").upsert(
      {
        user_id: user.id,
        word: next.word,
        reading: next.reading,
        level: next.level,
        learning_language: learningLanguage,
        state: next.state,
        preference: next.preference,
        known_source: next.known_source,
        correct_streak: next.correct_streak,
        srs_level: next.srs_level,
        srs_due_at: next.srs_due_at,
        last_reviewed_at: next.last_reviewed_at,
        marked_known_at: next.marked_known_at ?? null,
      },
      { onConflict: "user_id,word,learning_language" },
    );
    invalidateLocalSrsCache(user.id, learningLanguage);
  };

  // ---------- flow ----------
  const speakCard = async (c: VocabItem) => {
    awaitingRef.current = false;
    stopRecognition();
    await speak(spokenTargetFor(c), ttsLangFor(learningLanguage));
    if (modeRef.current === "review") {
      await new Promise((r) => setTimeout(r, 250));
      await speak("Do you know it?", "en-US", 1);
    } else {
      await new Promise((r) => setTimeout(r, 250));
      await speak("What does it mean?", "en-US", 1);
    }
    await new Promise((r) => setTimeout(r, 400));
    awaitingRef.current = true;
    if (runningRef.current) startRecognition();
  };

  const repeatPrompt = async () => {
    const c = vocabRef.current[idxRef.current];
    if (c) await speakCard(c);
  };

  const revealMeaning = async (c: VocabItem) => {
    awaitingRef.current = false;
    stopRecognition();
    await speak(c.reading || c.word, ttsLangFor(learningLanguage));
    await speak(c.meaning, "en-US", 1);
    awaitingRef.current = true;
    if (runningRef.current) startRecognition();
  };

  const finish = async () => {
    runningRef.current = false;
    setRunning(false);
    doneRef.current = true;
    setDone(true);
    awaitingRef.current = false;
    try {
      recognitionRef.current?.stop();
    } catch {
      // Ignore stop errors
    }
    const activeSessionId = sessionIdRef.current;
    if (activeSessionId) {
      await supabase.from("study_sessions").update({
        finished_at: new Date().toISOString(),
        words_studied: vocabRef.current.length,
        words_mastered: modeRef.current === "review" ? reviewedKnownRef.current : quizCorrectRef.current,
        mode: modeRef.current,
      }).eq("id", activeSessionId);
    }
    await speak("Session complete. Great job!", "en-US", 1);
  };

  const advance = async () => {
    const next = idxRef.current + 1;
    if (next >= vocabRef.current.length) {
      await finish();
      return;
    }
    setIdx(next);
    idxRef.current = next;
    setLastResult(null);
    if (runningRef.current) {
      const c = vocabRef.current[next];
      if (c) await speakCard(c);
    }
  };

  const gradeReview = async (known: boolean) => {
    awaitingRef.current = false;
    stopRecognition();
    const c = vocabRef.current[idxRef.current];
    if (!c) return;
    await recordWord(c, known);
    setLastResult(known ? "known" : "learning");
    if (known) {
      reviewedKnownRef.current += 1;
      setReviewedKnown((n) => n + 1);
    }
    await speak(known ? "Got it." : "Keep learning.", "en-US", 1);
    await speak(c.reading || c.word, ttsLangFor(learningLanguage));
    await speak(c.meaning, "en-US", 1);
    await advance();
  };

  const gradeQuiz = async (correct: boolean, c: VocabItem) => {
    awaitingRef.current = false;
    stopRecognition();
    if (correct) {
      quizCorrectRef.current += 1;
      setQuizCorrect((n) => n + 1);
    }
    setLastResult(correct ? "correct" : "wrong");
    const activeSessionId = sessionIdRef.current;
    if (activeSessionId && user) {
      await supabase.from("quiz_results").insert({
        session_id: activeSessionId,
        user_id: user.id,
        word: c.word,
        was_correct: correct,
        quiz_kind: "jp_to_meaning",
        learning_language: learningLanguage,
      });
    }
    await recordWord(c, correct);
    await speak(`${correct ? "Correct!" : "The answer was"} ${c.meaning}.`, "en-US", 1);
    await advance();
  };

  const pause = () => {
    runningRef.current = false;
    setRunning(false);
    awaitingRef.current = false;
    try {
      speechSynthesis.cancel();
    } catch {
      // Ignore TTS cancel errors
    }
    stopRecognition();
  };

  const resume = async () => {
    if (vocabRef.current.length === 0 || doneRef.current) return;
    setRunning(true);
    runningRef.current = true;
    const c = vocabRef.current[idxRef.current];
    if (c) await speakCard(c);
  };

  const handleVoiceInput = (transcripts: string[]) => {
    if (!runningRef.current || transcripts.length === 0) return;

    const allTokens = Array.from(new Set(transcripts.flatMap(tokensOf)));

    if (matchesPause(allTokens)) {
      pause();
      return;
    }
    if (matchesResume(allTokens)) {
      void resume();
      return;
    }

    if (!awaitingRef.current) return;
    const c = vocabRef.current[idxRef.current];
    if (!c) return;

    if (matchesRepeat(allTokens) && !matchesYes(allTokens) && !matchesNo(allTokens)) {
      void repeatPrompt();
      return;
    }

    if (modeRef.current === "review") {
      if (matchesMeaning(allTokens)) {
        void revealMeaning(c);
        return;
      }
      if (matchesYes(allTokens)) {
        void gradeReview(true);
        return;
      }
      if (matchesNo(allTokens)) {
        void gradeReview(false);
        return;
      }
    } else {
      if (matchesNo(allTokens)) {
        void gradeQuiz(false, c);
        return;
      }
      const targets = meaningVariants(c.meaning);
      const hit = transcripts.some((tr) => {
        const trN = normalize(tr);
        return targets.some((target) => target && (trN === target || trN.includes(target) || target.includes(trN)));
      });
      if (hit) {
        void gradeQuiz(true, c);
      }
    }
  };

  handleVoiceInputRef.current = handleVoiceInput;

  const start = async () => {
    if (!supported) {
      toast.error(t("voice.notSupportedToast"));
      return;
    }
    if (vocab.length === 0) return;
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPermissionDenied(true);
      toast.error(t("voice.micRequiredToast"));
      return;
    }
    setPermissionDenied(false);
    setRunning(true);
    runningRef.current = true;
    const c = vocabRef.current[idxRef.current];
    if (c) await speakCard(c);
  };

  const restart = () => {
    setIdx(0);
    idxRef.current = 0;
    reviewedKnownRef.current = 0;
    quizCorrectRef.current = 0;
    setReviewedKnown(0);
    setQuizCorrect(0);
    doneRef.current = false;
    setDone(false);
    setLastResult(null);
  };

  const switchMode = (m: Mode) => {
    pause();
    setMode(m);
    modeRef.current = m;
    restart();
  };

  // ---------- render ----------
  if (vocab.length === 0) {
    return (
      <div className="max-w-2xl mx-auto px-5 py-10 text-center">
        <p className="text-muted-foreground mb-4">{t("study.noNewTitle")}</p>
        <Button onClick={() => navigate(-1)}>{t("study.back")}</Button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="max-w-md mx-auto px-5 py-10 text-center">
        <Card className="p-8 gradient-card border-border/50 shadow-card animate-fade-in">
          <div className="text-5xl mb-3">🧼</div>
          <h2 className="text-2xl font-bold mb-2">{t("voice.handsCleanTitle")}</h2>
          <p className="text-sm text-muted-foreground mb-6">
            {mode === "review"
              ? t("voice.markedKnownOf", { known: reviewedKnown, total: vocab.length })
              : t("voice.gotCorrectOf", { correct: quizCorrect, total: vocab.length })}
          </p>
          <div className="grid gap-2">
            <Button onClick={() => navigate(`/episode/${episodeId}`)} className="gradient-primary text-primary-foreground">{t("study.backToEpisode")}</Button>
            <Button variant="outline" onClick={restart}>
              <RotateCw className="h-4 w-4" /> {t("voice.goAgain")}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-5 pt-4 pb-10">
      <div className="flex items-center justify-between mb-4">
        <Button variant="ghost" size="icon" onClick={() => { pause(); navigate(-1); }}><ChevronLeft className="h-5 w-5" /></Button>
        <div className="text-sm text-muted-foreground">{t("voice.handsFreeStudy")}</div>
        <div className="w-9" />
      </div>

      {!supported && (
        <Card className="p-4 mb-4 border-destructive/40 bg-destructive/5">
          <div className="flex gap-2 items-start">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5" />
            <div className="text-sm">
              <div className="font-semibold mb-1">{t("voice.notSupportedTitle")}</div>
              <div className="text-muted-foreground">{t("voice.notSupportedBody")}</div>
            </div>
          </div>
        </Card>
      )}

      {permissionDenied && (
        <Card className="p-4 mb-4 border-destructive/40 bg-destructive/5">
          <div className="flex gap-2 items-start">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5" />
            <div className="text-sm">
              <div className="font-semibold mb-1">{t("voice.micBlockedTitle")}</div>
              <div className="text-muted-foreground">{t("voice.micBlockedBody")}</div>
            </div>
          </div>
        </Card>
      )}

      {!!recognitionError && !permissionDenied && (
        <Card className="p-4 mb-4 border-destructive/40 bg-destructive/5">
          <div className="flex gap-2 items-start">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5" />
            <div className="text-sm">
              <div className="font-semibold mb-1">{t("voice.recognitionFailedTitle")}</div>
              <div className="text-muted-foreground">{t("voice.recognitionFailedBody", { error: recognitionError })}</div>
            </div>
          </div>
        </Card>
      )}

      <Tabs value={mode} onValueChange={(v) => switchMode(v as Mode)} className="w-full">
        <TabsList className="grid grid-cols-2 w-full mb-6">
          <TabsTrigger value="review">{t("study.review")}</TabsTrigger>
          <TabsTrigger value="quiz">{t("study.quiz")}</TabsTrigger>
        </TabsList>

        <TabsContent value={mode}>
          <Progress value={(idx / vocab.length) * 100} className="h-2 mb-4" />
          <div className="text-xs text-muted-foreground text-center mb-4">{idx + 1} / {vocab.length}</div>

          <Card className={`p-6 gradient-card border-border/50 shadow-card mb-4 text-center min-h-56 grid place-items-center transition ${
            lastResult === "known" || lastResult === "correct" ? "border-success/60" :
            lastResult === "learning" || lastResult === "wrong" ? "border-destructive/40" : ""
          }`}>
            <div>
              <div className={cn("text-5xl font-bold mb-2", learningLanguageInfo.hasRuby && "font-jp")}>
                {learningLanguageInfo.hasRuby ? ((showKanji ? card?.word : card?.reading) || card?.word) : card?.word}
              </div>
              {learningLanguageInfo.hasRuby && (showKanji
                ? <div className="font-jp text-muted-foreground">{card?.reading}</div>
                : card && card.word !== card.reading && (
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("study.hiraganaMode")}</div>
                ))}
              <div className="text-xs text-muted-foreground italic mt-3">{card?.part_of_speech} • {getLevel(card ?? { word: "", reading: "", meaning: "", part_of_speech: "", example_sentence_jp: "", example_sentence_en: "" })}</div>
            </div>
          </Card>

          <div className="flex items-center justify-center gap-2 mb-4 text-xs text-muted-foreground flex-wrap">
            <span className={`inline-flex items-center gap-1 ${listening ? "text-primary" : ""}`}>
              {listening ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
              {listening ? t("voice.listening") : t("voice.micOff")}
            </span>
            <span>• {heard ? t("voice.heard", { text: heard }) : t("voice.heardNothing")}</span>
          </div>

          <div className="grid grid-cols-3 gap-2 mb-3">
            {!running ? (
              <Button onClick={() => void start()} className="col-span-3 h-12 gradient-primary text-primary-foreground">
                <Play className="h-4 w-4" /> {t("voice.startHandsFree")}
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={pause} className="h-12">
                  <Pause className="h-4 w-4" /> {t("voice.pause")}
                </Button>
                <Button variant="outline" onClick={() => void repeatPrompt()} className="h-12">
                  <Volume2 className="h-4 w-4" /> {t("voice.repeat")}
                </Button>
                <Button variant="outline" onClick={() => void advance()} className="h-12">
                  <SkipForward className="h-4 w-4" /> {t("voice.skip")}
                </Button>
              </>
            )}
          </div>

          {running && mode === "review" && (
            <div className="grid grid-cols-2 gap-2 mb-4">
              <Button variant="outline" onClick={() => void gradeReview(false)} className="h-11">
                {t("study.stillLearning")}
              </Button>
              <Button onClick={() => void gradeReview(true)} className="h-11 bg-success text-success-foreground hover:bg-success/90">
                {t("study.iKnowThis")}
              </Button>
            </div>
          )}

          {window.self !== window.top && (
            <Card className="p-3 mb-4 border-accent/40 bg-accent/5 text-xs">
              <div className="font-semibold mb-1">{t("voice.previewTip")}</div>
              <div className="text-muted-foreground">
                {t("voice.previewTipBody")}
              </div>
            </Card>
          )}

          <Card className="p-3 gradient-card border-border/50 text-xs text-muted-foreground">
            <div className="font-semibold text-foreground mb-1">{t("voice.commandsTitle")}</div>
            {mode === "review" ? (
              <ul className="space-y-0.5">
                <li>• {t("voice.cmdReview1")}</li>
                <li>• {t("voice.cmdReview2")}</li>
                <li>• {t("voice.cmdReview3")}</li>
                <li>• {t("voice.cmdReview4")}</li>
                <li>• {t("voice.cmdReview5")}</li>
              </ul>
            ) : (
              <ul className="space-y-0.5">
                <li>• {t("voice.cmdQuiz1")}</li>
                <li>• {t("voice.cmdQuiz2")}</li>
                <li>• {t("voice.cmdQuiz3")}</li>
                <li>• {t("voice.cmdQuiz4")}</li>
              </ul>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

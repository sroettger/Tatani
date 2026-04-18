import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ChevronLeft, Mic, MicOff, Play, Pause, SkipForward, Volume2, RotateCw, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { toast } from "sonner";

type VocabItem = {
  word: string; reading: string; meaning: string; part_of_speech: string;
  jlpt_level: string; example_sentence_jp: string; example_sentence_en: string;
};

type Mode = "review" | "quiz";

// Single-token keywords (any of these as a word in the transcript triggers the action)
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
  meaning.split(/[,/;]| or | and /i).map(s => normalize(s)).filter(Boolean);

const hasAny = (tokens: string[], keywords: string[]) =>
  tokens.some(t => keywords.includes(t));

const matchesYes = (tokens: string[]) => hasAny(tokens, YES_TOKENS);
const matchesNo = (tokens: string[]) => hasAny(tokens, NO_TOKENS);
const matchesRepeat = (tokens: string[]) => hasAny(tokens, REPEAT_TOKENS);
const matchesMeaning = (tokens: string[]) => hasAny(tokens, MEANING_TOKENS);
const matchesPause = (tokens: string[]) => hasAny(tokens, PAUSE_TOKENS);
const matchesResume = (tokens: string[]) => hasAny(tokens, RESUME_TOKENS);

const JLPT_RANK: Record<string, number> = { N5: 1, N4: 2, N3: 3, N2: 4, N1: 5, none: 6 };
const KANJI_THRESHOLD = 2;

export default function VoiceStudySession() {
  const { episodeId } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();

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

  // refs to keep latest values inside SpeechRecognition handlers
  const recognitionRef = useRef<any>(null);
  const runningRef = useRef(false);
  const modeRef = useRef<Mode>("review");
  const idxRef = useRef(0);
  const vocabRef = useRef<VocabItem[]>([]);
  const awaitingRef = useRef(false); // waiting for user voice answer

  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { vocabRef.current = vocab; }, [vocab]);

  // ---------- load vocab + session ----------
  useEffect(() => {
    if (!episodeId || !user) return;
    (async () => {
      const { data: cache } = await supabase.from("episode_vocab_cache").select("vocab").eq("episode_id", episodeId).maybeSingle();
      const all = ((cache?.vocab ?? []) as VocabItem[]);
      const { data: states } = await supabase
        .from("user_word_state")
        .select("word,state,correct_streak")
        .eq("user_id", user.id);
      const knownSet = new Set((states ?? []).filter((k: any) => k.state === "known").map((k: any) => k.word));
      const trackedSet = new Set((states ?? []).map((k: any) => k.word));
      const streakMap: Record<string, number> = {};
      (states ?? []).forEach((s: any) => { streakMap[s.word] = s.correct_streak ?? 0; });
      setStreaks(streakMap);

      const myLevel = profile?.jlpt_level && profile.jlpt_level !== "none" ? profile.jlpt_level : null;
      const myRank = myLevel ? JLPT_RANK[myLevel] : 0;
      const isBelowLevel = (lvl: string) => myRank > 0 && (JLPT_RANK[lvl] ?? 99) < myRank;

      setVocab(all.filter(v =>
        !knownSet.has(v.word) &&
        (!isBelowLevel(v.jlpt_level) || trackedSet.has(v.word))
      ));

      const { data: sess } = await supabase
        .from("study_sessions")
        .insert({ user_id: user.id, episode_id: episodeId, mode: "review", words_studied: 0, words_mastered: 0 })
        .select("id").single();
      if (sess) setSessionId(sess.id);
    })();
  }, [episodeId, user, profile?.jlpt_level]);

  // ---------- speech recognition setup ----------
  useEffect(() => {
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }
    const r = new SR();
    // continuous=false is more reliable across browsers — we manually re-arm
    // after each TTS prompt so the mic is guaranteed to be open when the
    // user answers.
    r.continuous = false;
    r.interimResults = false;
    r.lang = "en-US";
    r.maxAlternatives = 5;

    r.onresult = (event: any) => {
      // collect every alternative from every result
      const transcripts: string[] = [];
      for (let i = 0; i < event.results.length; i++) {
        const res = event.results[i];
        if (!res.isFinal) continue;
        for (let j = 0; j < res.length; j++) transcripts.push(normalize(res[j].transcript));
      }
      if (transcripts.length === 0) return;
      setHeard(transcripts[0]);
      handleVoiceInput(transcripts);
    };
    r.onerror = (e: any) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setPermissionDenied(true);
        setRunning(false);
        runningRef.current = false;
        toast.error("Microphone permission denied");
        return;
      }
      // 'no-speech' / 'aborted' / 'audio-capture' — let onend handle restart
    };
    r.onend = () => {
      setListening(false);
      // auto-restart only when running AND we're awaiting an answer
      if (runningRef.current && awaitingRef.current) {
        try { r.start(); setListening(true); } catch { /* already started */ }
      }
    };

    recognitionRef.current = r;
    return () => { try { r.stop(); } catch {} recognitionRef.current = null; };
  }, []);

  // start/stop helpers that swallow "already started" errors
  const startRecognition = () => {
    const r = recognitionRef.current;
    if (!r) return;
    try { r.start(); setListening(true); } catch { /* already running */ }
  };
  const stopRecognition = () => {
    const r = recognitionRef.current;
    if (!r) return;
    try { r.abort(); } catch {}
    setListening(false);
  };

  // ---------- TTS ----------
  const speak = (text: string, lang = "ja-JP", rate = 0.95) =>
    new Promise<void>((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
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

  // ---------- DB write ----------
  const recordWord = async (word: string, reading: string, jlpt: string, gotItRight: boolean) => {
    if (!user) return;
    const { data: existing } = await supabase
      .from("user_word_state").select("state,correct_streak").eq("user_id", user.id).eq("word", word).maybeSingle();
    const prevStreak = existing?.correct_streak ?? 0;
    const prevState = existing?.state ?? "unknown";
    const newStreak = gotItRight ? prevStreak + 1 : 0;
    let newState: "unknown" | "learning" | "known" = prevState as any;
    if (gotItRight && newStreak >= 3) newState = "known";
    else if (gotItRight) newState = newState === "unknown" ? "learning" : newState;
    else newState = "learning";

    await supabase.from("user_word_state").upsert({
      user_id: user.id, word, reading, jlpt_level: (jlpt as any) ?? null,
      state: newState, correct_streak: newStreak, last_reviewed_at: new Date().toISOString(),
    }, { onConflict: "user_id,word" });
    setStreaks(prev => ({ ...prev, [word]: newStreak }));
    return newState;
  };

  // ---------- voice command handling ----------
  const handleVoiceInput = (transcripts: string[]) => {
    if (!runningRef.current) return;
    if (transcripts.length === 0) return;

    // tokenize every alternative into a single deduped token bag
    const allTokens = Array.from(new Set(transcripts.flatMap(tokensOf)));
    console.log("[voice] heard:", transcripts, "tokens:", allTokens, "awaiting:", awaitingRef.current);

    if (matchesPause(allTokens)) { console.log("[voice] -> pause"); pause(); return; }
    if (matchesResume(allTokens)) { console.log("[voice] -> resume"); resume(); return; }

    if (!awaitingRef.current) return;
    const c = vocabRef.current[idxRef.current];
    if (!c) return;

    // "repeat" only valid while awaiting (otherwise it loops with TTS feedback)
    if (matchesRepeat(allTokens) && !matchesYes(allTokens) && !matchesNo(allTokens)) {
      console.log("[voice] -> repeat"); repeatPrompt(); return;
    }

    if (modeRef.current === "review") {
      if (matchesMeaning(allTokens)) { console.log("[voice] -> meaning"); revealMeaning(c); return; }
      // YES wins ties (we want to be optimistic — user can say "skip" explicitly for no)
      if (matchesYes(allTokens)) { console.log("[voice] -> known"); gradeReview(true); return; }
      if (matchesNo(allTokens)) { console.log("[voice] -> learning"); gradeReview(false); return; }
      console.log("[voice] no match for review");
    } else {
      if (matchesNo(allTokens)) { console.log("[voice] -> quiz wrong"); gradeQuiz(false, c); return; }
      const targets = meaningVariants(c.meaning);
      const hit = transcripts.some(tr => {
        const trN = normalize(tr);
        return targets.some(target => target && (trN === target || trN.includes(target) || target.includes(trN)));
      });
      if (hit) { console.log("[voice] -> quiz correct"); gradeQuiz(true, c); return; }
      console.log("[voice] no quiz match, targets:", targets);
    }
  };

  // ---------- flow ----------
  const speakCard = async (c: VocabItem) => {
    awaitingRef.current = false;
    stopRecognition();
    await speak(showKanjiFor(c) ? c.word : c.reading);
    if (modeRef.current === "review") {
      await new Promise(r => setTimeout(r, 250));
      await speak("Do you know it?", "en-US", 1);
    } else {
      await new Promise(r => setTimeout(r, 250));
      await speak("What does it mean?", "en-US", 1);
    }
    // Re-arm mic AFTER TTS so the answer is captured cleanly.
    awaitingRef.current = true;
    if (runningRef.current) startRecognition();
  };

  const showKanjiFor = (c: VocabItem) =>
    (streaks[c.word] ?? 0) >= KANJI_THRESHOLD || c.word === c.reading;

  const repeatPrompt = async () => {
    const c = vocabRef.current[idxRef.current];
    if (c) await speakCard(c);
  };

  const revealMeaning = async (c: VocabItem) => {
    awaitingRef.current = false;
    stopRecognition();
    await speak(c.reading + ". " + c.meaning, "en-US", 1);
    awaitingRef.current = true;
    if (runningRef.current) startRecognition();
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
    const newState = await recordWord(c.word, c.reading, c.jlpt_level, known);
    if (newState === "known") setReviewedKnown(k => k + 1);
    setLastResult(known ? "known" : "learning");
    await speak(`${known ? "Got it." : "Keep learning."} ${c.reading}, ${c.meaning}.`, "en-US", 1);
    await advance();
  };

  const gradeQuiz = async (correct: boolean, c: VocabItem) => {
    awaitingRef.current = false;
    stopRecognition();
    if (correct) setQuizCorrect(n => n + 1);
    setLastResult(correct ? "correct" : "wrong");
    if (sessionId && user) {
      await supabase.from("quiz_results").insert({
        session_id: sessionId, user_id: user.id, word: c.word,
        was_correct: correct, quiz_kind: "jp_to_meaning",
      });
    }
    await recordWord(c.word, c.reading, c.jlpt_level, correct);
    await speak(`${correct ? "Correct!" : "The answer was"} ${c.meaning}.`, "en-US", 1);
    await advance();
  };

  const finish = async () => {
    runningRef.current = false;
    setRunning(false);
    setDone(true);
    awaitingRef.current = false;
    try { recognitionRef.current?.stop(); } catch {}
    if (sessionId) {
      await supabase.from("study_sessions").update({
        finished_at: new Date().toISOString(),
        words_studied: vocab.length,
        words_mastered: modeRef.current === "review" ? reviewedKnown : quizCorrect,
        mode: modeRef.current,
      }).eq("id", sessionId);
    }
    await speak("Session complete. Great job!", "en-US", 1);
  };

  const start = async () => {
    if (!supported) { toast.error("Voice recognition isn't supported in this browser. Try Chrome on Android or desktop."); return; }
    if (vocab.length === 0) return;
    try {
      // proactively prompt mic permission so we can show a clear error
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPermissionDenied(true);
      toast.error("Microphone access is required for voice mode");
      return;
    }
    setPermissionDenied(false);
    setRunning(true);
    runningRef.current = true;
    // speakCard will start the mic AFTER the prompt finishes
    const c = vocabRef.current[idxRef.current];
    if (c) await speakCard(c);
  };

  const pause = () => {
    runningRef.current = false;
    setRunning(false);
    awaitingRef.current = false;
    try { speechSynthesis.cancel(); } catch { }
    stopRecognition();
  };

  const resume = async () => {
    if (vocab.length === 0 || done) return;
    setRunning(true);
    runningRef.current = true;
    const c = vocabRef.current[idxRef.current];
    if (c) await speakCard(c);
  };

  const restart = () => {
    setIdx(0); idxRef.current = 0;
    setReviewedKnown(0); setQuizCorrect(0);
    setDone(false); setLastResult(null);
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
        <p className="text-muted-foreground mb-4">No new words to study — you already know everything in this episode!</p>
        <Button onClick={() => navigate(-1)}>Back</Button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="max-w-md mx-auto px-5 py-10 text-center">
        <Card className="p-8 gradient-card border-border/50 shadow-card animate-fade-in">
          <div className="text-5xl mb-3">🧼</div>
          <h2 className="text-2xl font-bold mb-2">Hands clean, brain full</h2>
          <p className="text-sm text-muted-foreground mb-6">
            {mode === "review"
              ? `You marked ${reviewedKnown} as known out of ${vocab.length}.`
              : `You got ${quizCorrect} / ${vocab.length} correct.`}
          </p>
          <div className="grid gap-2">
            <Button onClick={() => navigate(`/episode/${episodeId}`)} className="gradient-primary text-primary-foreground">Back to episode</Button>
            <Button variant="outline" onClick={restart}>
              <RotateCw className="h-4 w-4" /> Go again
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
        <div className="text-sm text-muted-foreground">Hands-free study</div>
        <div className="w-9" />
      </div>

      {!supported && (
        <Card className="p-4 mb-4 border-destructive/40 bg-destructive/5">
          <div className="flex gap-2 items-start">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5" />
            <div className="text-sm">
              <div className="font-semibold mb-1">Voice recognition not supported</div>
              <div className="text-muted-foreground">This browser doesn't support speech recognition. Try Chrome on Android or desktop, or fall back to the regular study mode.</div>
            </div>
          </div>
        </Card>
      )}

      {permissionDenied && (
        <Card className="p-4 mb-4 border-destructive/40 bg-destructive/5">
          <div className="flex gap-2 items-start">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5" />
            <div className="text-sm">
              <div className="font-semibold mb-1">Microphone blocked</div>
              <div className="text-muted-foreground">Allow microphone access in your browser settings, then reload this page.</div>
            </div>
          </div>
        </Card>
      )}

      <Tabs value={mode} onValueChange={(v) => switchMode(v as Mode)} className="w-full">
        <TabsList className="grid grid-cols-2 w-full mb-6">
          <TabsTrigger value="review">Review</TabsTrigger>
          <TabsTrigger value="quiz">Quiz</TabsTrigger>
        </TabsList>

        <TabsContent value={mode}>
          <Progress value={(idx / vocab.length) * 100} className="h-2 mb-4" />
          <div className="text-xs text-muted-foreground text-center mb-4">{idx + 1} / {vocab.length}</div>

          <Card className={`p-6 gradient-card border-border/50 shadow-card mb-4 text-center min-h-56 grid place-items-center transition ${
            lastResult === "known" || lastResult === "correct" ? "border-success/60" :
            lastResult === "learning" || lastResult === "wrong" ? "border-destructive/40" : ""
          }`}>
            <div>
              <div className="font-jp text-5xl font-bold mb-2">
                {showKanji ? card?.word : card?.reading}
              </div>
              {showKanji
                ? <div className="font-jp text-muted-foreground">{card?.reading}</div>
                : card && card.word !== card.reading && (
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Hiragana mode</div>
                )}
              <div className="text-xs text-muted-foreground italic mt-3">{card?.part_of_speech} • {card?.jlpt_level}</div>
            </div>
          </Card>

          <div className="flex items-center justify-center gap-2 mb-4 text-xs text-muted-foreground">
            <span className={`inline-flex items-center gap-1 ${listening ? "text-primary" : ""}`}>
              {listening ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
              {listening ? "Listening" : "Mic off"}
            </span>
            {heard && <span>• heard: "{heard}"</span>}
          </div>

          <div className="grid grid-cols-3 gap-2 mb-4">
            {!running ? (
              <Button onClick={start} className="col-span-3 h-12 gradient-primary text-primary-foreground">
                <Play className="h-4 w-4" /> Start hands-free
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={pause} className="h-12">
                  <Pause className="h-4 w-4" /> Pause
                </Button>
                <Button variant="outline" onClick={() => repeatPrompt()} className="h-12">
                  <Volume2 className="h-4 w-4" /> Repeat
                </Button>
                <Button variant="outline" onClick={() => advance()} className="h-12">
                  <SkipForward className="h-4 w-4" /> Skip
                </Button>
              </>
            )}
          </div>

          <Card className="p-3 gradient-card border-border/50 text-xs text-muted-foreground">
            <div className="font-semibold text-foreground mb-1">Voice commands</div>
            {mode === "review" ? (
              <ul className="space-y-0.5">
                <li>• <span className="text-foreground">"yes" / "know"</span> — I know this word</li>
                <li>• <span className="text-foreground">"no" / "skip"</span> — still learning</li>
                <li>• <span className="text-foreground">"meaning"</span> — hear the answer</li>
                <li>• <span className="text-foreground">"repeat"</span> — say the word again</li>
                <li>• <span className="text-foreground">"pause"</span> / <span className="text-foreground">"resume"</span></li>
              </ul>
            ) : (
              <ul className="space-y-0.5">
                <li>• Just <span className="text-foreground">say the meaning in English</span></li>
                <li>• <span className="text-foreground">"I don't know"</span> / <span className="text-foreground">"skip"</span></li>
                <li>• <span className="text-foreground">"repeat"</span> — hear word again</li>
                <li>• <span className="text-foreground">"pause"</span> / <span className="text-foreground">"resume"</span></li>
              </ul>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

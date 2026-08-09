import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { useAuth } from "@/context/AuthContext";
import { Settings as SettingsIcon, LogOut, RotateCw, Trash2, Film, Layers, Languages, GraduationCap } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useI18n, SUPPORTED_LANGUAGES, LangCode } from "@/i18n";
import { LEARNING_LANGUAGES, LearningLangCode, levelsFor, scaleLabel, formatLevel } from "@/lib/languages";
import {
  useStudyPrefs,
  CHUNK_SIZE_MIN,
  CHUNK_SIZE_MAX,
  QUEUE_SIZE_MIN,
  QUEUE_SIZE_MAX,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_QUEUE_SIZE,
} from "@/hooks/use-study-prefs";

// Common countries for streaming-region filtering. Extendable.
const COUNTRIES = [
  { code: "CH", name: "Switzerland" },
  { code: "US", name: "United States" },
  { code: "JP", name: "Japan" },
  { code: "GB", name: "United Kingdom" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
] as const;

export default function Settings() {
  const { profile, signOut, refreshProfile, user, learningLanguage, learningLanguageInfo, progress, setLearningLanguage } = useAuth();
  const navigate = useNavigate();
  const { t, lang, setLang } = useI18n();
  const { chunkSize, queueSize, setChunkSize, setQueueSize } = useStudyPrefs();

  const changeLanguage = async (code: LangCode) => {
    if (code === lang) return;
    try {
      await setLang(code);
      toast.success(t("settings.languageUpdated"));
    } catch {
      toast.error(t("settings.languageFailed"));
    }
  };

  const changeLearningLanguage = async (code: LearningLangCode) => {
    if (code === learningLanguage) return;
    try {
      await setLearningLanguage(code);
      const info = LEARNING_LANGUAGES.find((l) => l.code === code)!;
      toast.success(t("settings.learningUpdated", { lang: info.native }));
    } catch {
      toast.error(t("settings.learningFailed"));
    }
  };

  const setLevel = async (level: string) => {
    if (!user || progress?.level === level) return;
    const { error } = await supabase
      .from("user_language_progress")
      .update({ level, placement_done: true })
      .eq("user_id", user.id)
      .eq("learning_language", learningLanguage);
    if (error) {
      toast.error(t("settings.levelFailed"));
      return;
    }
    await refreshProfile();
    toast.success(t("settings.levelUpdated", { level }));
  };

  const setCountry = async (code: string | null) => {
    if (!user) return;
    const { error } = await supabase
      .from("profiles")
      .update({ country: code })
      .eq("user_id", user.id);
    if (error) {
      toast.error(t("settings.countryFailed"));
      return;
    }
    await refreshProfile();
    toast.success(code ? t("settings.countryUpdated", { code }) : t("settings.countryCleared"));
  };

  const retakePlacement = async () => {
    if (!user) return;
    await supabase
      .from("user_language_progress")
      .update({ placement_done: false, level: "none" })
      .eq("user_id", user.id)
      .eq("learning_language", learningLanguage);
    await refreshProfile();
    toast.success(t("settings.retakeToast"));
    navigate("/onboarding");
  };

  const resetStudyData = async () => {
    if (!user) return;
    if (!confirm(t("settings.resetConfirm"))) return;
    try {
      await Promise.all([
        supabase.from("user_word_state").delete().eq("user_id", user.id).eq("learning_language", learningLanguage),
        supabase.from("quiz_results").delete().eq("user_id", user.id).eq("learning_language", learningLanguage),
        supabase.from("study_sessions").delete().eq("user_id", user.id).eq("learning_language", learningLanguage),
      ]);
      await supabase
        .from("user_language_progress")
        .update({ placement_done: false, level: "none", total_words_known: 0, study_streak: 0 })
        .eq("user_id", user.id)
        .eq("learning_language", learningLanguage);
      await refreshProfile();
      toast.success(t("settings.resetDone"));
      navigate("/onboarding");
    } catch (e) {
      toast.error(t("settings.resetFailed"));
    }
  };

  const wipeAnimeData = async () => {
    if (!user) return;
    if (!confirm(t("settings.wipeConfirm"))) return;
    try {
      const { data, error } = await supabase.functions.invoke("wipe-anime-data", { body: {} });
      if (error) throw error;
      const counts = (data as any)?.counts ?? {};
      const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ");
      toast.success(t("settings.wipeDone"), { description: summary });
    } catch (e: any) {
      toast.error(t("settings.wipeFailed"), { description: e?.message ?? "" });
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} icon={<SettingsIcon className="h-4 w-4" />} />
      <div className="px-5 grid gap-3">
        <Card className="p-4 gradient-card border-border/50">
          <div className="flex items-center gap-3">
            {profile?.avatar_url && <img src={profile.avatar_url} alt="" className="h-12 w-12 rounded-full" />}
            <div>
              <div className="font-semibold">{profile?.display_name ?? t("settings.user")}</div>
              <div className="text-xs text-muted-foreground">
                {learningLanguageInfo.flag} {learningLanguageInfo.native} · {scaleLabel(learningLanguage)} {formatLevel(progress?.level)}
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-4 gradient-card border-border/50">
          <h3 className="font-semibold mb-1 flex items-center gap-2"><Languages className="h-4 w-4" /> {t("settings.language")}</h3>
          <p className="text-xs text-muted-foreground mb-3">{t("settings.languageHelp")}</p>
          <div className="flex flex-wrap gap-2">
            {SUPPORTED_LANGUAGES.map((l) => (
              <Button
                key={l.code}
                size="sm"
                variant={lang === l.code ? "default" : "outline"}
                onClick={() => changeLanguage(l.code)}
                className="h-9"
              >
                {l.native}
              </Button>
            ))}
          </div>
        </Card>

        <Card className="p-4 gradient-card border-border/50">
          <h3 className="font-semibold mb-1 flex items-center gap-2"><GraduationCap className="h-4 w-4" /> {t("settings.learning")}</h3>
          <p className="text-xs text-muted-foreground mb-3">{t("settings.learningHelp")}</p>
          <div className="flex flex-wrap gap-2">
            {LEARNING_LANGUAGES.map((l) => (
              <Button
                key={l.code}
                size="sm"
                variant={learningLanguage === l.code ? "default" : "outline"}
                onClick={() => changeLearningLanguage(l.code)}
                className="h-9"
              >
                <span className="mr-1">{l.flag}</span> {l.native}
              </Button>
            ))}
          </div>
        </Card>

        <Card className="p-4 gradient-card border-border/50">
          <h3 className="font-semibold mb-1">{t("settings.level", { scale: scaleLabel(learningLanguage) })}</h3>
          <p className="text-xs text-muted-foreground mb-3">{t("settings.levelHelp")}</p>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {levelsFor(learningLanguage).map((lvl) => (
              <Button
                key={lvl}
                variant={progress?.level === lvl ? "default" : "outline"}
                onClick={() => setLevel(lvl)}
                className="h-10"
              >
                {lvl}
              </Button>
            ))}
          </div>
        </Card>

        <Card className="p-4 gradient-card border-border/50">
          <h3 className="font-semibold mb-1">{t("settings.country")}</h3>
          <p className="text-xs text-muted-foreground mb-3">{t("settings.countryHelp")}</p>
          <div className="flex flex-wrap gap-2">
            {COUNTRIES.map((c) => (
              <Button
                key={c.code}
                size="sm"
                variant={profile?.country === c.code ? "default" : "outline"}
                onClick={() => setCountry(c.code)}
                className="h-8"
              >
                {c.code} <span className="text-xs text-muted-foreground ml-1">{c.name}</span>
              </Button>
            ))}
            {profile?.country && (
              <Button size="sm" variant="ghost" onClick={() => setCountry(null)} className="h-8 text-xs">
                {t("common.clear")}
              </Button>
            )}
          </div>
        </Card>

        <Card className="p-4 gradient-card border-border/50">
          <h3 className="font-semibold mb-1 flex items-center gap-2"><Layers className="h-4 w-4" /> {t("settings.batches")}</h3>
          <p className="text-xs text-muted-foreground mb-3">{t("settings.batchesHelp")}</p>
          <div className="grid gap-3">
            <div>
              <Label htmlFor="queue-size" className="text-xs">
                {t("settings.queueSize")}
                <span className="ml-1 text-muted-foreground/70 font-normal">
                  {t("settings.range", { min: QUEUE_SIZE_MIN, max: QUEUE_SIZE_MAX, def: DEFAULT_QUEUE_SIZE })}
                </span>
              </Label>
              <Input
                id="queue-size"
                type="number"
                min={QUEUE_SIZE_MIN}
                max={QUEUE_SIZE_MAX}
                value={queueSize}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setQueueSize(n);
                }}
                className="mt-1 h-9 w-28"
              />
              <p className="text-[11px] text-muted-foreground mt-1">{t("settings.queueHelp")}</p>
            </div>
            <div>
              <Label htmlFor="chunk-size" className="text-xs">
                {t("settings.chunkSize")}
                <span className="ml-1 text-muted-foreground/70 font-normal">
                  {t("settings.range", { min: CHUNK_SIZE_MIN, max: CHUNK_SIZE_MAX, def: DEFAULT_CHUNK_SIZE })}
                </span>
              </Label>
              <Input
                id="chunk-size"
                type="number"
                min={CHUNK_SIZE_MIN}
                max={CHUNK_SIZE_MAX}
                value={chunkSize}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setChunkSize(n);
                }}
                className="mt-1 h-9 w-28"
              />
              <p className="text-[11px] text-muted-foreground mt-1">{t("settings.chunkHelp")}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4 gradient-card border-border/50">
          <h3 className="font-semibold mb-1">{t("settings.retake")}</h3>
          <p className="text-xs text-muted-foreground mb-3">{t("settings.retakeHelp")}</p>
          <Button variant="outline" onClick={retakePlacement}><RotateCw className="h-4 w-4" /> {t("settings.retakeBtn")}</Button>
        </Card>

        <Card className="p-4 gradient-card border-border/50">
          <h3 className="font-semibold mb-1">{t("settings.reset")} <span className="text-xs text-muted-foreground font-normal">{t("settings.resetTag")}</span></h3>
          <p className="text-xs text-muted-foreground mb-3">{t("settings.resetHelp")}</p>
          <Button variant="outline" onClick={resetStudyData}><Trash2 className="h-4 w-4" /> {t("settings.resetBtn")}</Button>
        </Card>

        <Card className="p-4 gradient-card border-border/50">
          <h3 className="font-semibold mb-1">{t("settings.wipe")} <span className="text-xs text-muted-foreground font-normal">{t("settings.wipeTag")}</span></h3>
          <p className="text-xs text-muted-foreground mb-3">{t("settings.wipeHelp")}</p>
          <Button variant="outline" onClick={wipeAnimeData}><Film className="h-4 w-4" /> {t("settings.wipeBtn")}</Button>
        </Card>

        <Card className="p-4 gradient-card border-border/50">
          <h3 className="font-semibold mb-1">{t("settings.signOut")}</h3>
          <p className="text-xs text-muted-foreground mb-3">{t("settings.signOutHelp")}</p>
          <Button variant="destructive" onClick={async () => { await signOut(); navigate("/auth"); }}>
            <LogOut className="h-4 w-4" /> {t("settings.signOut")}
          </Button>
        </Card>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/i18n";
import { toast } from "sonner";
import { Loader2, Plus, Search } from "lucide-react";

export type AnimeSearchResult = {
  anilist_id: number;
  mal_id: number | null;
  title_romaji: string;
  title_en: string | null;
  title_jp: string | null;
  cover_url: string | null;
  year: number | null;
  episode_count: number;
  synopsis: string | null;
};

export function AddAnimeDialog({
  open,
  onOpenChange,
  onAdded,
  onAddingChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdded: () => Promise<void> | void;
  onAddingChange?: (anime: AnimeSearchResult | null) => void;
}) {
  const { user, learningLanguage, learningLanguageInfo } = useAuth();
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<AnimeSearchResult[]>([]);
  const [addingItem, setAddingItem] = useState<AnimeSearchResult | null>(null);

  useEffect(() => {
    if (!open) {
      setQ("");
      setResults([]);
    }
  }, [open]);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("search-anime", { body: { query: q } });
    setBusy(false);
    if (error) {
      toast.error(t("addAnime.searchFailed"), { description: error.message });
      return;
    }
    setResults(data?.results ?? []);
  };

  const add = async (r: AnimeSearchResult) => {
    if (!user || addingItem) return;
    setAddingItem(r);
    onAddingChange?.(r);
    try {
      const { data, error } = await supabase.functions.invoke("add-anime-to-library", {
        body: { anime: r, learning_language: learningLanguage },
      });
      if (error || data?.error) {
        toast.error(t("addAnime.addFailed"), { description: error?.message ?? data?.error });
        return;
      }
      await onAdded();
      toast.success(t("addAnime.added"));
      onOpenChange(false);
    } finally {
      setAddingItem(null);
      onAddingChange?.(null);
    }
  };

  const addingTitle = addingItem ? (addingItem.title_en ?? addingItem.title_romaji) : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t("addAnime.title")}</DialogTitle></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); void search(); }} className="flex gap-2">
          <Input placeholder={t("addAnime.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          </Button>
        </form>

        {addingItem && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 space-y-2"
          >
            <div className="flex items-center gap-2 text-xs font-medium text-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary flex-shrink-0" />
              <span className="min-w-0">
                {addingItem.episode_count > 0
                  ? t("addAnime.addingBanner", { title: addingTitle, n: addingItem.episode_count })
                  : t("addAnime.addingBannerNoCount", { title: addingTitle })}
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
            </div>
          </div>
        )}

        <div className="grid gap-2 mt-2">
          {results.map((r) => {
            const isAddingThis = addingItem?.anilist_id === r.anilist_id;
            return (
              <button
                key={r.anilist_id}
                type="button"
                disabled={addingItem !== null}
                onClick={() => void add(r)}
                className="flex items-center gap-3 text-left p-2 rounded-lg border border-border hover:border-primary/50 hover:bg-muted/30 disabled:opacity-60 disabled:cursor-not-allowed transition"
              >
                <div className="w-12 h-16 rounded bg-muted overflow-hidden flex-shrink-0">
                  {r.cover_url && <img src={r.cover_url} alt={r.title_romaji} className="w-full h-full object-cover" loading="lazy" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{r.title_en ?? r.title_romaji}</div>
                  {r.title_jp && learningLanguageInfo.hasRuby && <div className="font-jp text-xs text-muted-foreground truncate">{r.title_jp}</div>}
                  <div className="text-xs text-muted-foreground mt-1">{r.year ?? "—"} • {r.episode_count || "?"} eps</div>
                </div>
                <div className="flex-shrink-0 pr-1 text-xs font-medium text-primary inline-flex items-center gap-1">
                  {isAddingThis ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>{t("addAnime.addingBtn")}</span>
                    </>
                  ) : (
                    <>
                      <Plus className="h-3.5 w-3.5" />
                      <span>{t("common.add")}</span>
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

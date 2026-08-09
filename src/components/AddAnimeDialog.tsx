import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/i18n";
import { toast } from "sonner";
import { Loader2, Search } from "lucide-react";

type SearchResult = {
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
  open, onOpenChange, onAdded,
}: { open: boolean; onOpenChange: (o: boolean) => void; onAdded: () => void }) {
  const { user, learningLanguageInfo } = useAuth();
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);

  useEffect(() => {
    if (!open) { setQ(""); setResults([]); }
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

  const add = async (r: SearchResult) => {
    if (!user) return;
    const { data, error } = await supabase.functions.invoke("add-anime-to-library", { body: { anime: r } });
    if (error || data?.error) {
      toast.error(t("addAnime.addFailed"), { description: error?.message ?? data?.error });
      return;
    }
    toast.success(t("addAnime.added"));
    onAdded();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t("addAnime.title")}</DialogTitle></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); search(); }} className="flex gap-2">
          <Input placeholder={t("addAnime.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <Button type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}</Button>
        </form>
        <div className="grid gap-2 mt-2">
          {results.map((r) => (
            <button
              key={r.anilist_id}
              onClick={() => add(r)}
              className="flex gap-3 text-left p-2 rounded-lg border border-border hover:border-primary/50 hover:bg-muted/30 transition"
            >
              <div className="w-12 h-16 rounded bg-muted overflow-hidden flex-shrink-0">
                {r.cover_url && <img src={r.cover_url} alt={r.title_romaji} className="w-full h-full object-cover" loading="lazy" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">{r.title_en ?? r.title_romaji}</div>
                {r.title_jp && learningLanguageInfo.hasRuby && <div className="font-jp text-xs text-muted-foreground truncate">{r.title_jp}</div>}
                <div className="text-xs text-muted-foreground mt-1">{r.year ?? "—"} • {r.episode_count || "?"} eps</div>
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Plus, ChevronRight, Sparkles, Trash2, GripVertical, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { PageHeader } from "@/components/PageHeader";
import { useI18n } from "@/i18n";
import { AddAnimeDialog, type AnimeSearchResult } from "@/components/AddAnimeDialog";
import { invalidateLocalSrsCache } from "@/lib/srs-store";
import { fetchAllPages, fetchBatchedPages } from "@/lib/supabase-pagination";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/hooks/use-toast";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

type AnimeRow = {
  id: string;
  title_romaji: string;
  title_en: string | null;
  title_jp: string | null;
  cover_url: string | null;
  year: number | null;
  episode_count: number;
};

type UserAnimeRow = {
  id: string;
  added_at: string;
  position: number;
  anime: AnimeRow | null;
};

type LibraryEntry = {
  id: string;
  added_at: string;
  position: number;
  anime: AnimeRow;
  processed: number;
};

function SortableLibraryCard({
  entry,
  onOpen,
  onRemove,
}: {
  entry: LibraryEntry;
  onOpen: () => void;
  onRemove: (e: React.MouseEvent) => void;
}) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.id });
  const total = entry.anime.episode_count || 0;
  const pct = total > 0 ? Math.round((entry.processed / total) * 100) : 0;
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : "auto",
  };

  return (
    <div ref={setNodeRef} style={style} className="min-w-0">
      <Card
        className="p-3 gradient-card border-border/50 cursor-pointer hover:border-primary/40 transition-all shadow-card overflow-hidden"
        onClick={onOpen}
      >
        <div className="flex gap-2 items-stretch min-w-0">
          <button
            type="button"
            className="flex items-center justify-center -ml-1 text-muted-foreground hover:text-foreground touch-none cursor-grab active:cursor-grabbing flex-shrink-0"
            aria-label={t("home.dragToReorder")}
            onClick={(e) => e.stopPropagation()}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-5 w-5" />
          </button>
          <div className="w-14 h-20 rounded-lg overflow-hidden bg-muted flex-shrink-0">
            {entry.anime.cover_url ? (
              <img src={entry.anime.cover_url} alt={entry.anime.title_romaji} className="w-full h-full object-cover" loading="lazy" />
            ) : <div className="w-full h-full grid place-items-center text-muted-foreground text-xs">{t("home.noCover")}</div>}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold truncate">{entry.anime.title_en ?? entry.anime.title_romaji}</div>
            {entry.anime.title_jp && <div className="font-jp text-xs text-muted-foreground truncate">{entry.anime.title_jp}</div>}
            <div className="text-xs text-muted-foreground mt-1 truncate">
              {t("home.epsReady", { done: entry.processed, total: total || "?" })}
            </div>
            <Progress value={pct} className="h-1.5 mt-2" />
          </div>
          <div className="flex flex-col items-center justify-between flex-shrink-0">
            <ChevronRight className="h-5 w-5 text-muted-foreground" />
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={onRemove}
              aria-label={t("home.removeAnime")}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

export default function Home() {
  const { user, profile, learningLanguage, progress } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [addingAnime, setAddingAnime] = useState<AnimeSearchResult | null>(null);
  const [removeTarget, setRemoveTarget] = useState<LibraryEntry | null>(null);
  const [removing, setRemoving] = useState(false);

  const userId = user?.id;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    const { data } = await supabase
      .from("user_anime")
      .select("id, added_at, position, anime:anime_id(id,title_romaji,title_en,title_jp,cover_url,year,episode_count)")
      .eq("user_id", userId)
      .eq("learning_language", learningLanguage)
      .order("position", { ascending: true })
      .order("added_at", { ascending: false });

    const validRows = ((data ?? []) as UserAnimeRow[]).filter(
      (r): r is UserAnimeRow & { anime: AnimeRow } => Boolean(r.anime),
    );
    const animeIds = validRows.map((r) => r.anime.id);

    const processedByAnime = new Map<string, number>();
    if (animeIds.length > 0) {
      const { data: epRows } = await fetchAllPages<{
        id: string;
        seasons: { anime_id: string };
      }>((from, to) =>
        supabase
          .from("episodes")
          .select("id, seasons!inner(anime_id)")
          .in("seasons.anime_id", animeIds)
          .order("id", { ascending: true })
          .range(from, to),
      );

      const epIds = epRows.map((e) => e.id);
      if (epIds.length > 0) {
        const { data: cachedRows } = await fetchBatchedPages<string, { episode_id: string }>(
          epIds,
          200,
          (slice, from, to) =>
            supabase
              .from("episode_vocab_cache")
              .select("episode_id")
              .in("episode_id", slice)
              .eq("language", learningLanguage)
              .order("episode_id", { ascending: true })
              .range(from, to),
        );
        const cachedEpisodeSet = new Set(cachedRows.map((c) => c.episode_id));
        for (const ep of epRows) {
          if (cachedEpisodeSet.has(ep.id)) {
            const aid = ep.seasons.anime_id;
            processedByAnime.set(aid, (processedByAnime.get(aid) ?? 0) + 1);
          }
        }
      }
    }

    const enriched: LibraryEntry[] = validRows.map((r) => ({
      ...r,
      processed: processedByAnime.get(r.anime.id) ?? 0,
    }));
    setLibrary(enriched);
    setLoading(false);
  }, [userId, learningLanguage]);

  useEffect(() => {
    void load();
  }, [load]);

  const removeAnime = async () => {
    if (!removeTarget || !user) return;
    setRemoving(true);
    const { error } = await supabase
      .from("user_anime")
      .delete()
      .eq("id", removeTarget.id)
      .eq("user_id", user.id);
    setRemoving(false);
    if (error) {
      toast({ title: t("home.removeFailed"), description: error.message, variant: "destructive" });
      return;
    }
    setLibrary((prev) => prev.filter((e) => e.id !== removeTarget.id));
    invalidateLocalSrsCache(user.id, learningLanguage);
    toast({ title: t("home.removed"), description: t("home.removedBody", { title: removeTarget.anime.title_en ?? removeTarget.anime.title_romaji }) });
    setRemoveTarget(null);
  };

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !user) return;
    const oldIndex = library.findIndex((e) => e.id === active.id);
    const newIndex = library.findIndex((e) => e.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(library, oldIndex, newIndex).map((e, i) => ({ ...e, position: i }));
    setLibrary(reordered);

    const updates = await Promise.all(
      reordered.map((e) =>
        supabase
          .from("user_anime")
          .update({ position: e.position })
          .eq("id", e.id)
          .eq("user_id", user.id),
      ),
    );
    const failed = updates.find((r) => r.error);
    if (failed?.error) {
      toast({ title: t("home.orderFailed"), description: failed.error.message, variant: "destructive" });
      void load();
    } else {
      invalidateLocalSrsCache(user.id, learningLanguage);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader
        title={profile?.display_name ? t("home.welcomeNamed", { name: profile.display_name.split(" ")[0] }) : t("home.welcome")}
        subtitle={progress?.level && progress.level !== "none" ? t("home.level", { level: progress.level }) : t("home.tagline")}
        icon={<Sparkles className="h-4 w-4" />}
      />

      <div className="px-5 mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("home.yourAnime")}</h2>
        <Button size="sm" className="gradient-primary text-primary-foreground" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" /> {t("common.add")}
        </Button>
      </div>

      <div className="px-5 grid gap-3 min-w-0">
        {addingAnime && (
          <Card
            role="status"
            aria-live="polite"
            className="p-3 gradient-card border-primary/50 shadow-card overflow-hidden"
          >
            <div className="flex gap-3 items-center min-w-0">
              <div className="w-12 h-16 rounded-lg overflow-hidden bg-muted flex-shrink-0">
                {addingAnime.cover_url ? (
                  <img
                    src={addingAnime.cover_url}
                    alt={addingAnime.title_romaji}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full grid place-items-center text-muted-foreground text-xs">
                    {t("home.noCover")}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm truncate">
                  {t("home.addingCardTitle", {
                    title: addingAnime.title_en ?? addingAnime.title_romaji,
                  })}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 truncate">
                  {addingAnime.episode_count > 0
                    ? t("home.addingCardSub", { n: addingAnime.episode_count })
                    : t("home.addingCardSubNoCount")}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted mt-2">
                  <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
                </div>
              </div>
              <Loader2 className="h-5 w-5 animate-spin text-primary flex-shrink-0" />
            </div>
          </Card>
        )}
        {loading && !addingAnime && <div className="text-muted-foreground text-sm">{t("common.loading")}</div>}
        {!loading && library.length === 0 && !addingAnime && (
          <Card className="p-8 text-center gradient-card border-border/50">
            <div className="text-4xl mb-2">🎬</div>
            <h3 className="font-semibold mb-1">{t("home.noAnimeTitle")}</h3>
            <p className="text-sm text-muted-foreground mb-4">{t("home.noAnimeBody")}</p>
            <Button onClick={() => setAddOpen(true)} className="gradient-primary text-primary-foreground">
              <Plus className="h-4 w-4" /> {t("home.addAnime")}
            </Button>
          </Card>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={library.map((e) => e.id)} strategy={verticalListSortingStrategy}>
            {library.map((entry) => (
              <SortableLibraryCard
                key={entry.id}
                entry={entry}
                onOpen={() => navigate(`/anime/${entry.anime.id}`)}
                onRemove={(e) => { e.stopPropagation(); setRemoveTarget(entry); }}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      <AddAnimeDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAddingChange={setAddingAnime}
        onAdded={async () => {
          if (user) invalidateLocalSrsCache(user.id, learningLanguage);
          await load();
        }}
      />

      <AlertDialog open={!!removeTarget} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("home.removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget && t("home.removeBody", { title: removeTarget.anime.title_en ?? removeTarget.anime.title_romaji })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void removeAnime(); }}
              disabled={removing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? t("home.removing") : t("common.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

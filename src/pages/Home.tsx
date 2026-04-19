import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Plus, ChevronRight, Sparkles, Trash2, GripVertical } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { PageHeader } from "@/components/PageHeader";
import { AddAnimeDialog } from "@/components/AddAnimeDialog";
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
type LibraryEntry = { id: string; added_at: string; position: number; anime: AnimeRow; processed: number };

function SortableLibraryCard({
  entry,
  onOpen,
  onRemove,
}: {
  entry: LibraryEntry;
  onOpen: () => void;
  onRemove: (e: React.MouseEvent) => void;
}) {
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
    <div ref={setNodeRef} style={style}>
      <Card
        className="p-3 gradient-card border-border/50 cursor-pointer hover:border-primary/40 transition-all shadow-card overflow-hidden"
        onClick={onOpen}
      >
        <div className="flex gap-2 items-stretch min-w-0">
          <button
            type="button"
            className="flex items-center justify-center -ml-1 text-muted-foreground hover:text-foreground touch-none cursor-grab active:cursor-grabbing flex-shrink-0"
            aria-label="Drag to reorder"
            onClick={(e) => e.stopPropagation()}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-5 w-5" />
          </button>
          <div className="w-14 h-20 rounded-lg overflow-hidden bg-muted flex-shrink-0">
            {entry.anime.cover_url ? (
              <img src={entry.anime.cover_url} alt={entry.anime.title_romaji} className="w-full h-full object-cover" loading="lazy" />
            ) : <div className="w-full h-full grid place-items-center text-muted-foreground text-xs">No cover</div>}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold truncate">{entry.anime.title_en ?? entry.anime.title_romaji}</div>
            {entry.anime.title_jp && <div className="font-jp text-xs text-muted-foreground truncate">{entry.anime.title_jp}</div>}
            <div className="text-xs text-muted-foreground mt-1 truncate">
              {entry.processed} / {total || "?"} eps ready
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
              aria-label="Remove anime"
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
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<LibraryEntry | null>(null);
  const [removing, setRemoving] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
      toast({ title: "Couldn't remove", description: error.message, variant: "destructive" });
      return;
    }
    setLibrary(prev => prev.filter(e => e.id !== removeTarget.id));
    toast({ title: "Removed", description: `${removeTarget.anime.title_en ?? removeTarget.anime.title_romaji} removed from your library.` });
    setRemoveTarget(null);
  };

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from("user_anime")
      .select("id, added_at, position, anime:anime_id(id,title_romaji,title_en,title_jp,cover_url,year,episode_count)")
      .eq("user_id", user.id)
      .order("position", { ascending: true })
      .order("added_at", { ascending: false });

    const rows = (data ?? []) as any[];
    const enriched: LibraryEntry[] = await Promise.all(rows.map(async (r) => {
      const { count } = await supabase
        .from("episodes")
        .select("id, seasons!inner(anime_id)", { count: "exact", head: true })
        .eq("seasons.anime_id", r.anime.id)
        .eq("processing_status", "ready");
      return { ...r, processed: count ?? 0 };
    }));
    setLibrary(enriched);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [user]);

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !user) return;
    const oldIndex = library.findIndex(e => e.id === active.id);
    const newIndex = library.findIndex(e => e.id === over.id);
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
      toast({ title: "Couldn't save order", description: failed.error.message, variant: "destructive" });
      load();
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader
        title={`Welcome back${profile?.display_name ? `, ${profile.display_name.split(" ")[0]}` : ""}`}
        subtitle={profile?.jlpt_level && profile.jlpt_level !== "none" ? `Level ${profile.jlpt_level}` : "Anime Trainer"}
        icon={<Sparkles className="h-4 w-4" />}
      />

      <div className="px-5 mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Your anime</h2>
        <Button size="sm" className="gradient-primary text-primary-foreground" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>

      <div className="px-5 grid gap-3">
        {loading && <div className="text-muted-foreground text-sm">Loading…</div>}
        {!loading && library.length === 0 && (
          <Card className="p-8 text-center gradient-card border-border/50">
            <div className="text-4xl mb-2">🎬</div>
            <h3 className="font-semibold mb-1">No anime yet</h3>
            <p className="text-sm text-muted-foreground mb-4">Add your first anime to get started.</p>
            <Button onClick={() => setAddOpen(true)} className="gradient-primary text-primary-foreground">
              <Plus className="h-4 w-4" /> Add anime
            </Button>
          </Card>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={library.map(e => e.id)} strategy={verticalListSortingStrategy}>
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

      <AddAnimeDialog open={addOpen} onOpenChange={setAddOpen} onAdded={load} />

      <AlertDialog open={!!removeTarget} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from library?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget && `"${removeTarget.anime.title_en ?? removeTarget.anime.title_romaji}" will be removed from your library. Your study progress and learned words are kept.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); removeAnime(); }}
              disabled={removing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

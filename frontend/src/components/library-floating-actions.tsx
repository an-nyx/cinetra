import { useEffect, useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { MovieService, ShowService } from "@/services";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import AddMovieModal from "@/modals/AddMovieModal";
import AddShowModal from "@/modals/AddShowModal";
import MovieModal from "@/modals/MovieModal";
import ShowModal from "@/modals/ShowModal";
import { searchLibrary } from "@/lib/library-search";
import { posterSrc } from "@/lib/poster";
import type { MovieType, ShowType } from "@/types";
import { phrase, useLanguage } from "@/i18n";


export default function LibraryFloatingActions({ onUpdated }: { onUpdated: () => void }) {
  const { language } = useLanguage();
  const [open, setOpen] = useState(false);
  const [add, setAdd] = useState<"movie" | "show" | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [movies, setMovies] = useState<MovieType[]>([]);
  const [shows, setShows] = useState<ShowType[]>([]);
  const [selected, setSelected] = useState<{ kind: "movie" | "show"; id: string } | null>(null);
  const results = useMemo(() => searchLibrary(movies, shows, query), [movies, shows, query]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setStatus("");
    // Only authenticated library endpoints: typing never calls TMDB.
    Promise.all([MovieService.getAllMovies(), ShowService.getAllShows()])
      .then(([savedMovies, savedShows]) => {
        if (active) { setMovies(savedMovies); setShows(savedShows); setLoading(false); }
      })
      .catch(() => {
        if (active) { setLoading(false); setStatus("Could not load your library. Please try again."); }
      });
    return () => { active = false; };
  }, [open, retry]);

  const closeDetails = () => { setSelected(null); onUpdated(); };
  return <>
    <div className="library-floating-actions fixed z-30 flex flex-col sm:hidden" style={{ right: "max(34px, env(safe-area-inset-right))", top: "min(58dvh, calc(100dvh - 240px - env(safe-area-inset-bottom)))" }}>
      <button className="library-floating-button library-floating-search" aria-label={phrase(language, "Search my library")} onClick={() => { setQuery(""); setLoading(true); setOpen(true); }}><Search size={24} strokeWidth={1.7} /></button>
      <DropdownMenu><DropdownMenuTrigger asChild><button className="library-floating-button library-floating-add" aria-label={phrase(language, "Add to library")}><Plus size={24} strokeWidth={1.7} /></button></DropdownMenuTrigger>
        <DropdownMenuContent side="left" align="end" sideOffset={12} className="rounded-xl bg-zinc-950/95 p-2 text-white backdrop-blur-xl">
          <DropdownMenuItem onSelect={() => setAdd("show")}>{phrase(language, "Add TV Show")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAdd("movie")}>{phrase(language, "Add Movie")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden"><DialogHeader><DialogTitle>{phrase(language, "Search my library")}</DialogTitle><DialogDescription>{phrase(language, "Find movies and TV shows saved in your library.")}</DialogDescription></DialogHeader>
      <Input autoFocus type="search" aria-label={phrase(language, "Search my library")} placeholder={phrase(language, "Search saved titles…")} value={query} onChange={e => setQuery(e.target.value)} className="shrink-0 text-base" />
      <div role="status" className="text-sm text-muted-foreground">
        {loading ? phrase(language, "Loading your library…") : status ? phrase(language, status) : !query.trim() ? phrase(language, "Type a title to search your library.") : results.length ? phrase(language, results.length === 1 ? "1 matching title" : "{n} matching titles").replace("{n}", String(results.length)) : phrase(language, "No matching titles in your library.")}
        {status && <button className="ml-2 min-h-11 underline" onClick={() => setRetry(value => value + 1)}>{phrase(language, "Try again")}</button>}
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        {!loading && !status && results.map(result => <button key={`${result.kind}-${result.id}`} className="flex min-h-20 w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { setOpen(false); setSelected({ kind: result.kind, id: result.id }); }}>
          {result.posterURL ? <img src={posterSrc(result.posterURL, "w154")} alt="" loading="lazy" className="h-20 w-14 shrink-0 rounded object-cover" /> : <span aria-hidden="true" className="flex h-20 w-14 shrink-0 items-center justify-center rounded bg-muted text-xs">{phrase(language, "No poster")}</span>}
          <span className="min-w-0"><span className="block break-words font-medium">{result.name}</span><span className="block text-sm text-muted-foreground">{phrase(language, result.kind === "movie" ? "Movie" : "TV show")} · {phrase(language, result.statusLabel)}</span></span>
        </button>)}
      </div>
    </DialogContent></Dialog>
    {selected?.kind === "movie" && <MovieModal selectedMovie={selected.id} closeModal={closeDetails} movies={movies} setMovies={setMovies} />}
    {selected?.kind === "show" && <ShowModal type="show" selectedShow={selected.id} closeModal={closeDetails} shows={shows} setShows={setShows} />}
    <AddMovieModal modalStatus={add === "movie"} setModalStatus={value => { if (!value) setAdd(null); }} movies={movies} setMovies={value => { setMovies(value); onUpdated(); }} />
    <AddShowModal modalStatus={add === "show"} setModalStatus={value => { if (!value) setAdd(null); }} shows={shows} setShows={value => { setShows(value); onUpdated(); }} />
  </>;
}

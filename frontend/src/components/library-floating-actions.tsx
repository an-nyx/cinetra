import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { MovieService, ShowService } from "@/services";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import AddMovieModal from "@/modals/AddMovieModal";
import AddShowModal from "@/modals/AddShowModal";
import SearchResultItem, { type SearchResult } from "@/components/search-result-item";
import type { MovieType, ShowType } from "@/types";
import useDebounce from "@/hooks/use-debounce";

export default function LibraryFloatingActions({ onUpdated }: { onUpdated: () => void }) {
  const [open, setOpen] = useState(false);
  const [add, setAdd] = useState<"movie" | "show" | null>(null);
  const [query, setQuery] = useState("");
  const term = useDebounce(query, 300);
  const [results, setResults] = useState<(SearchResult & { mediaKind: string })[]>([]);
  const [status, setStatus] = useState("");
  const [movies, setMovies] = useState<MovieType[]>([]);
  const [shows, setShows] = useState<ShowType[]>([]);
  useEffect(() => {
    let active = true;
    setResults([]);
    if (!open || !term.trim()) { setStatus(""); return; }
    setStatus("Searching…");
    Promise.all([MovieService.searchMovies(term), ShowService.searchShows(term)])
      .then(([a, b]) => { if (active) { setResults([...a.map(r => ({ ...r, mediaKind: "movie" })), ...b.map(r => ({ ...r, mediaKind: "show" }))]); setStatus(a.length + b.length ? "" : "No results found."); } })
      .catch(() => { if (active) setStatus("Search failed. Please try again."); });
    return () => { active = false; };
  }, [term, open]);
  return <>
    <div className="library-floating-actions fixed z-30 flex flex-col sm:hidden" style={{ right: "max(34px, env(safe-area-inset-right))", top: "min(58dvh, calc(100dvh - 240px - env(safe-area-inset-bottom)))" }}>
      <button className="library-floating-button library-floating-search" aria-label="Search movies and TV shows" onClick={() => { setQuery(""); setOpen(true); }}><Search size={24} strokeWidth={1.7} /></button>
      <DropdownMenu><DropdownMenuTrigger asChild><button className="library-floating-button library-floating-add" aria-label="Add to library"><Plus size={24} strokeWidth={1.7} /></button></DropdownMenuTrigger>
        <DropdownMenuContent side="left" align="end" sideOffset={12} className="rounded-xl bg-zinc-950/95 p-2 text-white backdrop-blur-xl">
          <DropdownMenuItem onSelect={() => setAdd("show")}>Add TV Show</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAdd("movie")}>Add Movie</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[80dvh] overflow-y-auto"><DialogHeader><DialogTitle>Search</DialogTitle><DialogDescription>Find movies and TV shows.</DialogDescription></DialogHeader>
      <Input aria-label="Search movies and TV shows" placeholder="Search movies and TV shows…" value={query} onChange={e => setQuery(e.target.value)} />
      <p role="status" className="text-sm text-muted-foreground">{status}</p>
      {results.map((result, index) => <SearchResultItem key={`${result.id}-${index}`} index={index} searchResult={result} onSearchResultClick={() => { setOpen(false); setAdd(result.mediaKind === "movie" ? "movie" : "show"); }} />)}
    </DialogContent></Dialog>
    <AddMovieModal modalStatus={add === "movie"} setModalStatus={value => { if (!value) setAdd(null); }} movies={movies} setMovies={value => { setMovies(value); onUpdated(); }} />
    <AddShowModal modalStatus={add === "show"} setModalStatus={value => { if (!value) setAdd(null); }} shows={shows} setShows={value => { setShows(value); onUpdated(); }} />
  </>;
}

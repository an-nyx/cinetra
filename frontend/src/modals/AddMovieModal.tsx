import { T } from "@/i18n";
import { useEffect, useState } from "react";
import { MovieService } from "@/services";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import useDebounce from "@/hooks/use-debounce";
import { MovieType } from "@/types";
import SearchResultItem, { SearchResult } from "@/components/search-result-item";

interface AddMovieModalProps {
  modalStatus: boolean;
  setModalStatus: (value: boolean) => void;
  movies: MovieType[];
  setMovies: (value: MovieType[]) => void;
}

export default function AddMovieModal({
  modalStatus,
  setModalStatus,
  movies,
  setMovies,
}: AddMovieModalProps) {
  const [searchTerm, setSearch] = useState<string>("");
  const debouncedSearchTerm = useDebounce(searchTerm, 300);
  const [searchResult, setSearchResult] = useState<SearchResult[]>([]);

  const [movie, setMovie] = useState<SearchResult>({
    name: "",
    overview: "",
    posterURL: "",
  });

  const closeModal = () => {
    setModalStatus(false);
    setSearch("");
    setSearchResult([]);
    setMovie({
      name: "",
      overview: "",
      posterURL: "",
    });
  };

  const onSearchResultClick = (searchResult: SearchResult) => {
    const { id, name, overview, posterURL } = searchResult;
    
    setMovie({
      name,
      overview,
      posterURL,
      id,
    });
    setSearch("");
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!movie.name || !movie.id) return;

    MovieService.createMovie({ name: movie.name, overview: movie.overview, posterURL: movie.posterURL, tmdbId: movie.id })
      .then((newMovie) => {
        setMovies([newMovie, ...movies]);
        window.dispatchEvent(new Event("movies-updated"));
      })
      .catch((err) => {
        console.error(err);
        if (err.response?.status === 409) {
          alert(
            `the movie you're trying to add already exists in your list.`,
          );
        }
      })
      .finally(() => {
        closeModal();
      });
  };

  useEffect(() => {
    if (!debouncedSearchTerm) {
      setSearchResult([]);
      return;
    }
    
    MovieService.searchMovies(debouncedSearchTerm)
      .then((results) => {
        setSearchResult(results);
      })
      .catch((err) => {
        console.error(err);
        alert(
          "something went wrong! please refresh the page and try again or contact the developer. Thank you 😘",
        );
      });
  }, [debouncedSearchTerm]);

  return (
    <Dialog open={modalStatus} onOpenChange={(open) => { if (!open) closeModal(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle><T>Add a movie</T></DialogTitle>
          <DialogDescription>
            <T>Add the movie you watched and keep track of it.</T>
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Search Section */}
          <div className="space-y-1">
            <Label htmlFor="searchInput" className="text-sm font-medium">
              <T>Search the movie you want to add</T>
            </Label>
            <Input
              id="searchInput"
              placeholder={`Search movie...`}
              value={searchTerm}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-md"
            />
            {searchResult.length > 0 && (
              <ScrollArea className="h-[200px] w-full rounded-md border">
                <ul className="p-2 space-y-1">
                  {searchResult.map((item, index) => (
                    <li
                      key={index}
                      className="px-2 py-1 text-sm hover:bg-muted rounded cursor-pointer"
                    >
                      <SearchResultItem
                        index={index}
                        searchResult={item}
                        onSearchResultClick={onSearchResultClick}
                      />
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
          </div>

          {movie.name && (
            <div className="flex gap-4 rounded-xl border bg-muted/40 p-3">
              <img src={movie.posterURL} alt="" className="h-28 w-[4.7rem] shrink-0 rounded-lg object-cover" />
              <div className="min-w-0">
                <p className="mb-1 text-xs text-primary"><T>Ready to add</T></p>
                <h3 className="font-semibold">{movie.name}</h3>
                <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{movie.overview}</p>
              </div>
            </div>
          )}

          {/* Footer Buttons */}
          <DialogFooter className="flex justify-end gap-2">
            <Button
              variant="outline"
              type="button"
              onClick={() => closeModal()}
            >
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={!movie.name}><T>Add to library</T></Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useState } from "react";
import { ShowService } from "@/services";
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
import { ShowType } from "@/types";
import SearchResultItem, { SearchResult } from "@/components/search-result-item";

interface AddShowModalProps {
  modalStatus: boolean;
  setModalStatus: (value: boolean) => void;
  shows: ShowType[];
  setShows: (value: ShowType[]) => void;
}

export default function AddShowModal({
  modalStatus,
  setModalStatus,
  shows,
  setShows,
}: AddShowModalProps) {
  const [searchTerm, setSearch] = useState<string>("");
  const debouncedSearchTerm = useDebounce(searchTerm, 300);
  const [searchResults, setSearchResult] = useState<SearchResult[]>([]);

  const [show, setShow] = useState<SearchResult>({
    name: "",
    overview: "",
    posterURL: "",
  });

  const closeModal = () => {
    setModalStatus(false);
    setSearch("");
    setSearchResult([]);
    setShow({
      name: "",
      overview: "",
      posterURL: "",
    });
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!show.name || (!show.id && !show.tvmazeId)) return;

    ShowService.createShow({ name: show.name, overview: show.overview, posterURL: show.posterURL, ...(show.id ? { tmdbId: show.id } : { tvmazeId: show.tvmazeId }) })
      .then((newShow) => {
        setShows([newShow, ...shows]);
      })
      .catch((err) => {
        console.error(err);
        if (err.response?.status === 409) {
          alert(
            `the show you're trying to add already exists in your list.`,
          );
        }
      })
      .finally(() => {
        closeModal();
      });
  };

  const onSearchResultClick = (searchResult: SearchResult) => {
    const { id, tvmazeId, name, overview, posterURL } = searchResult;

    setShow({
      name,
      overview,
      posterURL,
      id,
      tvmazeId,
    });
    setSearch("");
  };

  useEffect(() => {
    if (!debouncedSearchTerm) {
      setSearchResult([]);
      return;
    }
    
    ShowService.searchShows(debouncedSearchTerm)
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
          <DialogTitle>Add a show</DialogTitle>
          <DialogDescription>
            Add the show you watched and keep track of it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Search Section */}
          <div className="space-y-1">
            <Label htmlFor="searchInput" className="text-sm font-medium">
              Search the show you want to add
            </Label>
            <Input
              id="searchInput"
              placeholder={`Search show...`}
              value={searchTerm}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-md"
            />
            {searchResults.length > 0 && (
              <ScrollArea className="h-[200px] w-full rounded-md border">
                <ul className="p-2 space-y-1">
                  {searchResults.map((searchResult, index) => (
                    <li
                      key={index}
                      className="px-2 py-1 text-sm hover:bg-muted rounded cursor-pointer"
                    >
                      <SearchResultItem
                        index={index}
                        searchResult={searchResult}
                        onSearchResultClick={onSearchResultClick}
                      />
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
          </div>

          {show.name && (
            <div className="flex gap-4 rounded-xl border bg-muted/40 p-3">
              <img src={show.posterURL} alt="" className="h-28 w-[4.7rem] shrink-0 rounded-lg object-cover" />
              <div className="min-w-0">
                <p className="mb-1 text-xs text-primary">Ready to add</p>
                <h3 className="font-semibold">{show.name}</h3>
                <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{show.overview}</p>
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
              Cancel
            </Button>
            <Button type="submit" disabled={!show.name}>Add to library</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

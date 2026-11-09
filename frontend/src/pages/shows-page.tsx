import { useNavigate } from "react-router";
import { useState, useEffect } from "react";
import { ShowService } from "@/services";
import type { TrackingSummary } from "@/services/show.service";

import ShowModal from "../modals/ShowModal.tsx";
import AddShowModal from "../modals/AddShowModal.tsx";

import Show from "@/components/Show.tsx";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ShowType } from "@/types/index.ts";
import { Plus, RefreshCw, Search } from "lucide-react";
import { filterAndSortShows, personalStatusLabels, type LibraryFilters, type PersonalStatus } from "@/lib/show-library";

type ListFiltersType = LibraryFilters;

export default function ShowsPage() {
  const [addShowModalStatus, setAddShowModalStatus] = useState<boolean>(false);
  const [shows, setShows] = useState<ShowType[]>([]);
  const [tracking, setTracking] = useState<TrackingSummary[]>([]);
  const [selectedShow, setSelectedShow] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [filters, setFilters] = useState<ListFiltersType>(() => {
    const savedSort = localStorage.getItem('showsSortBy');
    return savedSort ? { sortBy: savedSort as ListFiltersType['sortBy'] } : {};
  });
  const navigate = useNavigate();
  const [key, setKey] = useState(+new Date());

  useEffect(() => {
    const loadShows = async () => {
      try {
        const showsData = await ShowService.getAllShows();
        setShows(showsData);
      } catch (error) {
        console.error("error occurred loading shows", error);
        navigate("/login");
      }
    };

    loadShows();
  }, []);

  useEffect(() => {
    const refresh = () => { ShowService.getLibraryTracking().then(setTracking).catch(() => {}); };
    refresh();
    window.addEventListener('tracking-updated', refresh);
    return () => window.removeEventListener('tracking-updated', refresh);
  }, [shows.length]);

  const markNext = async (item: TrackingSummary) => {
    if (!item.nextEpisode) return;
    try { await ShowService.setEpisodeWatched(item.showId, item.nextEpisode.season, item.nextEpisode.number, true); setTracking(await ShowService.getLibraryTracking()); }
    catch (error) { console.error('Could not mark next episode watched', error); }
  };

  useEffect(() => {
    if (filters.sortBy) {
      localStorage.setItem('showsSortBy', filters.sortBy);
    } else {
      localStorage.removeItem('showsSortBy');
    }
  }, [filters.sortBy]);

  return (
    <div className="library-page mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-8">
      <div className="library-heading mb-7 flex flex-col gap-5">
        <div><p className="cinema-eyebrow mb-2">Your library</p><h1 className="text-4xl font-semibold tracking-tight">TV shows<span className="ml-3 text-base font-normal text-muted-foreground">{shows.length}</span></h1></div>
        <div className="flex min-w-0 items-center gap-3">
          <InputGroup>
            <InputGroupInput
              id="search"
              type="text"
              name="search"
              aria-label="Search your shows"
              placeholder="Search for a show..."
              value={search}
              onChange={(e) => setSearch(e.target.value.toLowerCase())}
              className="min-w-0 w-full"
            />
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
          </InputGroup>
          <Button
            onClick={() => setAddShowModalStatus(true)}
            className="shrink-0 gap-2 rounded-xl font-medium"
          >
            <Plus className="size-4" /><span>Add show</span>
          </Button>
          <AddShowModal
            modalStatus={addShowModalStatus}
            setModalStatus={setAddShowModalStatus}
            shows={shows}
            setShows={setShows}
          />
        </div>
      </div>

      <div className="library-filters mb-6 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            key={`favorite-${key}`}
            name="favoriteFilter"
            onValueChange={(value: "favorite" | "notFavorite") =>
              setFilters({ ...filters, favoriteFilter: value })
            }
          >
            <SelectTrigger aria-label="Filter favorites" className="w-auto min-w-[130px]">
              <SelectValue placeholder="All favorites" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="favorite">Favorite</SelectItem>
              <SelectItem value="notFavorite">Not Favorite</SelectItem>
            </SelectContent>
          </Select>

          <Select
            key={`complete-${key}`}
            name="completeFilter"
            onValueChange={(value: "completed" | "notCompleted") =>
              setFilters({ ...filters, completeFilter: value })
            }
          >
            <SelectTrigger aria-label="Filter completion" className="w-auto min-w-[130px]">
              <SelectValue placeholder="All completion" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="notCompleted">Not Completed</SelectItem>
            </SelectContent>
          </Select>

          <Select key={`status-${key}`} name="statusFilter" value={filters.statusFilter ?? "all"} onValueChange={(value: PersonalStatus | "all") => setFilters({ ...filters, statusFilter: value === "all" ? undefined : value })}>
            <SelectTrigger aria-label="Filter watching status" className="w-auto min-w-[190px] max-w-full">
              <SelectValue placeholder="All watching statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All watching statuses</SelectItem>
              {(['watching', 'completed', 'dropped', 'planned', 'paused', 'none'] as const).map(status => <SelectItem key={status} value={status}>{personalStatusLabels[status]}</SelectItem>)}
            </SelectContent>
          </Select>

          {(filters.favoriteFilter || filters.completeFilter || filters.statusFilter) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilters({
                  favoriteFilter: undefined,
                  completeFilter: undefined,
                  sortBy: filters.sortBy,
                });
                setKey(+new Date());
              }}
              className="flex items-center gap-1.5 h-9"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </Button>
          )}
        </div>

        <Select
          key={`sort-${key}`}
          name="sortBy"
          value={filters.sortBy ?? ""}
          onValueChange={(value: "nameAsc" | "nameDesc" | "dateNewest" | "dateOldest" | "updatedNewest" | "updatedOldest") =>
            setFilters({ ...filters, sortBy: value })
          }
        >
          <SelectTrigger aria-label="Sort library" className="w-auto min-w-[130px]">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="nameAsc">Name (A-Z)</SelectItem>
            <SelectItem value="nameDesc">Name (Z-A)</SelectItem>
            <SelectItem value="dateNewest">Date Added (Newest)</SelectItem>
            <SelectItem value="dateOldest">Date Added (Oldest)</SelectItem>
            <SelectItem value="updatedNewest">Updated (Newest)</SelectItem>
            <SelectItem value="updatedOldest">Updated (Oldest)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Separator className="mb-6" />

      {(() => {
        const sortedShows = filterAndSortShows(shows, search, filters);

        if (sortedShows.length === 0) {
          return (
            <div className="cinema-empty flex flex-col items-center justify-center px-4 py-16">
              <div className="text-center space-y-4">
                <div className="text-6xl mb-4">📺</div>
                <h3 className="text-xl font-semibold text-foreground">
                  {shows.length === 0 ? "No shows yet" : "No shows found"}
                </h3>
                <p className="text-muted-foreground max-w-md">
                  {shows.length === 0
                    ? "Start building your collection by adding your first show!"
                    : "Try adjusting your search or filters to find what you're looking for."}
                </p>
                {shows.length === 0 && (
                  <Button
                    onClick={() => setAddShowModalStatus(true)}
                    className="mt-4"
                  >
                    Add Your First Show
                  </Button>
                )}
              </div>
            </div>
          );
        }

        return (
          <div className="grid w-full grid-cols-2 gap-x-4 gap-y-7 min-[480px]:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {sortedShows.map((show) => (
              <Show
                type="show"
                key={show.id}
                {...show}
                shows={shows}
                setShows={setShows}
                setSelectedShow={setSelectedShow}
                tracking={tracking.find(item => item.showId === show.id)}
                onMarkNext={markNext}
              />
            ))}
          </div>
        );
      })()}
    

      <ShowModal
        type="show"
        selectedShow={selectedShow}
        closeModal={() => setSelectedShow("")}
        shows={shows}
        setShows={setShows}
      />
    </div>
  );
}

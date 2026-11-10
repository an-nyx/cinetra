import { T, phrase, useLanguage } from "@/i18n";
import { useNavigate } from "react-router";
import { useState, useEffect } from "react";
import { MovieService } from "@/services";

import MovieModal from "../modals/MovieModal.tsx";
import AddMovieModal from "../modals/AddMovieModal.tsx";

import Movie from "@/components/Movie.tsx";
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
import { useMovieDiscovery } from "@/hooks/use-movie-discovery";
import { MovieType } from "@/types/index.ts";
import { Plus, RefreshCw, Search, SlidersHorizontal } from "lucide-react";

interface ListFiltersType {
  favoriteFilter?: "favorite" | "notFavorite";
  sortBy?: "nameAsc" | "nameDesc" | "dateNewest" | "dateOldest" | "updatedNewest" | "updatedOldest";
}

export default function MoviesPage() {
  const { language } = useLanguage();
  const [addMovieModalStatus, setAddMovieModalStatus] = useState<boolean>(false);
  const [movies, setMovies] = useState<MovieType[]>([]);
  const [selectedMovie, setSelectedMovie] = useState<string>("");
  const [controlsOpen, setControlsOpen] = useState(false);
  const { data: discovery } = useMovieDiscovery();
  const [search, setSearch] = useState<string>("");
  const [filters, setFilters] = useState<ListFiltersType>(() => {
    const savedSort = localStorage.getItem('moviesSortBy');
    return savedSort ? { sortBy: savedSort as ListFiltersType['sortBy'] } : {};
  });
  const navigate = useNavigate();
  const [key, setKey] = useState(+new Date());

  useEffect(() => {
    const loadMovies = async () => {
      try {
        const moviesData = await MovieService.getAllMovies();
        setMovies(moviesData);
      } catch (error) {
        console.error("error occurred loading movies", error);
        navigate("/login");
      }
    };

    loadMovies();
  }, []);

  useEffect(() => {
    if (filters.sortBy) {
      localStorage.setItem('moviesSortBy', filters.sortBy);
    } else {
      localStorage.removeItem('moviesSortBy');
    }
  }, [filters.sortBy]);

  return (
    <div className="library-page mx-auto w-full max-w-7xl px-4 py-2 sm:py-6 md:px-8 md:py-8">
      <div className="library-heading mb-2 flex flex-col gap-2 sm:mb-7 sm:gap-5">
        <div className="hidden sm:block"><p className="cinema-eyebrow mb-2"><T>Your library</T></p><h1 className="text-4xl font-semibold tracking-tight"><T>Movies</T><span className="ml-3 text-base font-normal text-muted-foreground">{movies.length}</span></h1></div>
        <div className={`${controlsOpen ? "flex" : "hidden"} min-w-0 items-center gap-2 sm:flex`}>
          <InputGroup>
            <InputGroupInput
              id="search"
              type="text"
              name="search"
              aria-label={phrase(language, "Search your movies")}
              placeholder={phrase(language, "Search for a movie...")}
              value={search}
              onChange={(e) => setSearch(e.target.value.toLowerCase())}
              className="min-w-0 w-full"
            />
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
          </InputGroup>
          <Button
            onClick={() => setAddMovieModalStatus(true)}
            className="shrink-0 gap-2 rounded-xl font-medium"
          >
            <Plus className="size-4" /><span><T>Add movie</T></span>
          </Button>
          <AddMovieModal
            modalStatus={addMovieModalStatus}
            setModalStatus={setAddMovieModalStatus}
            movies={movies}
            setMovies={setMovies}
          />
        </div>
      </div>

      <div className="mb-2 flex items-center gap-2 sm:hidden">
        <h1 className="min-w-0 flex-1 text-lg font-semibold"><T>Movies</T> <span className="text-xs font-normal text-muted-foreground">{movies.length}</span></h1>
        <Button type="button" variant="outline" size="icon" aria-label={phrase(language, "Search and filter movies")} aria-expanded={controlsOpen} onClick={() => setControlsOpen(open => !open)}><SlidersHorizontal className="size-4" /></Button>
        <Button type="button" size="icon" aria-label={phrase(language, "Add movie")} onClick={() => setAddMovieModalStatus(true)}><Plus className="size-4" /></Button>
      </div>
      <div className={`library-filters mb-2 flex-wrap items-center gap-2 sm:mb-6 sm:flex ${controlsOpen ? "flex" : "hidden"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            key={`favorite-${key}`}
            name="favoriteFilter"
            onValueChange={(value: "favorite" | "notFavorite") =>
              setFilters({ ...filters, favoriteFilter: value })
            }
          >
            <SelectTrigger aria-label={phrase(language, "Filter favorites")} className="w-auto min-w-[130px]">
              <SelectValue placeholder={phrase(language, "All favorites")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="favorite"><T>Favorite</T></SelectItem>
              <SelectItem value="notFavorite"><T>Not Favorite</T></SelectItem>
            </SelectContent>
          </Select>

          {filters.favoriteFilter && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFilters({
                  favoriteFilter: undefined,
                  sortBy: filters.sortBy,
                });
                setKey(+new Date());
              }}
              className="flex items-center gap-1.5 h-9"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span><T>Reset</T></span>
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
          <SelectTrigger aria-label={phrase(language, "Sort library")} className="w-auto min-w-[130px]">
            <SelectValue placeholder={phrase(language, "Sort by")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="nameAsc"><T>Name (A-Z)</T></SelectItem>
            <SelectItem value="nameDesc"><T>Name (Z-A)</T></SelectItem>
            <SelectItem value="dateNewest"><T>Date Added (Newest)</T></SelectItem>
            <SelectItem value="dateOldest"><T>Date Added (Oldest)</T></SelectItem>
            <SelectItem value="updatedNewest"><T>Updated (Newest)</T></SelectItem>
            <SelectItem value="updatedOldest"><T>Updated (Oldest)</T></SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Separator className="mb-2 sm:mb-6" />

      {(() => {
        const filteredMovies = movies?.filter((movie) => {
          if (!movie.name.toLowerCase().includes(search)) return false;

          if (filters.favoriteFilter === "favorite" && movie.favorite !== true)
            return false;

          if (
            filters.favoriteFilter === "notFavorite" &&
            movie.favorite !== false
          )
            return false;

          return true;
        });

        // Apply sorting
        const sortedMovies = [...filteredMovies].sort((a, b) => {
          switch (filters.sortBy) {
          case "nameAsc":
            return a.name.localeCompare(b.name);
          case "nameDesc":
            return b.name.localeCompare(a.name);
          case "dateNewest":
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          case "dateOldest":
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          case "updatedNewest":
            return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
          case "updatedOldest":
            return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
          default:
            return 0;
          }
        });

        if (sortedMovies.length === 0) {
          return (
            <div className="cinema-empty flex flex-col items-center justify-center px-4 py-16">
              <div className="text-center space-y-4">
                <div className="text-6xl mb-4">🎬</div>
                <h3 className="text-xl font-semibold text-foreground">
                  {phrase(language, movies.length === 0 ? "No movies yet" : "No movies found")}
                </h3>
                <p className="text-muted-foreground max-w-md">
                  {movies.length === 0
                    ? phrase(language, "Start building your collection by adding your first movie!")
                    : phrase(language, "Try adjusting your search or filters to find what you're looking for.")}
                </p>
                {movies.length === 0 && (
                  <Button
                    onClick={() => setAddMovieModalStatus(true)}
                    className="mt-4"
                  >
                    <T>Add Your First Movie</T>
                  </Button>
                )}
              </div>
            </div>
          );
        }

        return (
          <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
            {sortedMovies.map((movie) => (
              <Movie
                key={movie.id}
                {...movie}
                year={movie.tmdbId ? discovery?.years[movie.tmdbId] : undefined}
                movies={movies}
                setMovies={setMovies}
                setSelectedMovie={setSelectedMovie}
              />
            ))}
          </div>
        );
      })()}

      <MovieModal
        selectedMovie={selectedMovie}
        closeModal={() => setSelectedMovie("")}
        movies={movies}
        setMovies={setMovies}
      />
    </div>
  );
}

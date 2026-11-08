export interface SearchResult {
  id?: number;
  tvmazeId?: number;
  name: string;
  overview: string;
  posterURL: string;
}

interface SearchResultItemProps {
  index: number;
  searchResult: SearchResult;
  onSearchResultClick: (searchResult: SearchResult) => void;
}

export default function SearchResultItem({ searchResult, onSearchResultClick }: SearchResultItemProps) {
  const { name, overview, posterURL } = searchResult;

  return (
    <button
      type="button"
      className="flex w-full min-w-0 gap-3 rounded-xl p-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary"
      onClick={() => onSearchResultClick(searchResult)}
    >
      <img src={posterURL} className="h-20 w-14 shrink-0 rounded-md object-cover" alt="" loading="lazy" />
      <span className="min-w-0">
        <span className="line-clamp-2 font-medium">{name}</span>
        <span className="mt-1 line-clamp-2 text-sm text-muted-foreground">{overview}</span>
      </span>
    </button>
  );
}

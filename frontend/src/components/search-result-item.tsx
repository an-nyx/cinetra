import TmdbResultCard, { type TmdbResult } from "@/components/tmdb-result-card";

export type SearchResult = TmdbResult & { overview: string; posterURL: string };

interface SearchResultItemProps {
  index: number;
  searchResult: SearchResult;
  onSearchResultClick: (searchResult: SearchResult) => void;
}

/** Add show results use the same compact card as Edit show: poster, title, year and overview. */
export default function SearchResultItem({ searchResult, onSearchResultClick }: SearchResultItemProps) {
  return <TmdbResultCard result={searchResult} onSelect={() => onSearchResultClick(searchResult)} />;
}

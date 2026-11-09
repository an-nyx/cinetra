/** TMDB serves the same poster at several widths; request one close to the size it is displayed at. */
export type PosterSize = "w92" | "w154" | "w185" | "w342" | "w500";
export function posterSrc(url: string | null | undefined, size: PosterSize): string | undefined {
  if (!url) return undefined;
  return url.replace(/(image\.tmdb\.org\/t\/p\/)w\d+\//, `$1${size}/`);
}

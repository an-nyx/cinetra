import { Star } from "lucide-react";
import { phrase, useLanguage } from "@/i18n";
import { ratingStars } from "@/lib/movie-library";

/**
 * Read-only personal rating for library cards: five small gold stars (each worth 2 points, so odd ratings show a half
 * star) and the score out of 10. Renders nothing when the movie has no saved rating.
 */
export default function MovieRating({ rating }: { rating: number | null | undefined }) {
  const { language } = useLanguage();
  const stars = ratingStars(rating);
  if (!stars || rating === null || rating === undefined) return null;
  const label = language === "ar" ? `تقييمك ${rating} من 10` : language === "fr" ? `Votre note : ${rating} sur 10` : `Your rating: ${rating} out of 10`;
  return (
    <span className="flex min-w-0 items-center gap-1 leading-4" role="img" aria-label={label} title={phrase(language, "Your rating")}>
      <span className="flex shrink-0" aria-hidden="true">
        {stars.map((fill, index) => (
          <span key={index} className="relative size-3">
            <Star className="absolute inset-0 size-3 text-amber-300/35" strokeWidth={2} />
            <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill}%` }}><Star className="size-3 fill-amber-300 text-amber-300" strokeWidth={2} /></span>
          </span>
        ))}
      </span>
      <span className="truncate text-[11px] font-medium tabular-nums text-amber-200/90" aria-hidden="true"><bdi dir="ltr">{rating}/10</bdi></span>
    </span>
  );
}

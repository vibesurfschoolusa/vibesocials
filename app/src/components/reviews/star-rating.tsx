import { Star } from "lucide-react";
import { STAR_RATINGS, type StarRatingKey } from "./types";

/**
 * Renders a 5-star row with the given rating filled in.
 */
export function StarRating({ rating }: { rating: StarRatingKey }) {
  const numStars = STAR_RATINGS[rating];
  return (
    // R23 pages L3: role="img" so screen readers read the label (a plain div's is skipped).
    <div className="flex gap-0.5" role="img" aria-label={`${numStars} out of 5 stars`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          aria-hidden
          className={`h-4 w-4 ${
            i < numStars
              ? "fill-warning text-warning"
              : "fill-muted text-muted"
          }`}
        />
      ))}
    </div>
  );
}

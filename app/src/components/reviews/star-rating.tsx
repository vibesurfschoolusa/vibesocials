import { Star } from "lucide-react";
import { STAR_RATINGS, type StarRatingKey } from "./types";

/**
 * Renders a 5-star row with the given rating filled in.
 */
export function StarRating({ rating }: { rating: StarRatingKey }) {
  const numStars = STAR_RATINGS[rating];
  return (
    <div className="flex gap-0.5" aria-label={`${numStars} out of 5 stars`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={`h-4 w-4 ${
            i < numStars
              ? "fill-yellow-400 text-yellow-400"
              : "fill-gray-200 text-gray-200"
          }`}
        />
      ))}
    </div>
  );
}

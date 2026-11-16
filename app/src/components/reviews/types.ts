export interface GoogleReview {
  name: string;
  reviewId: string;
  reviewer: {
    profilePhotoUrl?: string;
    displayName: string;
    isAnonymous: boolean;
  };
  starRating: "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE";
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: {
    comment: string;
    updateTime: string;
  };
}

export interface Location {
  name: string;
  locationName: string;
  title: string;
  /** R26 client-journey L4: the locations route sends both; null when Google has none. */
  storeCode?: string | null;
  /** One-line address, when the API returns one; used only to tell same-named locations apart. */
  address?: string | null;
}

export const STAR_RATINGS = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
} as const;

export type StarRatingKey = keyof typeof STAR_RATINGS;

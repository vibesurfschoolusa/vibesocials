import { describe, expect, it } from "vitest";

import { buildNewReviewsEmail, type NewReviewSummary } from "./newReviewsEmail";

function review(over: Partial<NewReviewSummary> = {}): NewReviewSummary {
  return { starRating: "FIVE", reviewerName: "Dana", comment: "Great lesson!", ...over };
}

const BASE = "https://vibesocials.example";

/** The email for these reviews, all of them new. */
function emailFor(reviews: NewReviewSummary[], over: { locationTitle?: string; appBaseUrl?: string | null } = {}) {
  return buildNewReviewsEmail({
    locationTitle: over.locationTitle ?? "Surf Co",
    count: reviews.length,
    reviews,
    appBaseUrl: over.appBaseUrl === undefined ? BASE : over.appBaseUrl,
  });
}

describe("buildNewReviewsEmail", () => {
  it("says 1 new Google review, singular", () => {
    expect(emailFor([review()]).subject).toBe("1 new Google review for Surf Co");
  });

  it("says n new Google reviews, plural", () => {
    expect(emailFor([review(), review()]).subject).toBe("2 new Google reviews for Surf Co");
  });

  it("lists each review's stars out of 5, name and comment", () => {
    const { html } = emailFor([review({ starRating: "FOUR", reviewerName: "Sam", comment: "Fun day" })]);
    expect(html).toContain("4 out of 5 stars");
    expect(html).toContain("Sam");
    expect(html).toContain("Fun day");
  });

  it("shows 10 of 11 reviews and says and 1 more", () => {
    const reviews = Array.from({ length: 11 }, (_, i) => review({ reviewerName: `Person ${i + 1}` }));
    const { subject, html } = emailFor(reviews);
    expect(subject).toBe("11 new Google reviews for Surf Co");
    expect(html).toContain("Person 10");
    expect(html).not.toContain("Person 11");
    expect(html).toContain("and 1 more");
    expect(html.match(/<li>/g)).toHaveLength(10);
  });

  it("counts the reviews it was not given excerpts for in and m more", () => {
    const { subject, html } = buildNewReviewsEmail({
      locationTitle: "Surf Co",
      count: 14,
      reviews: Array.from({ length: 10 }, () => review()),
      appBaseUrl: BASE,
    });
    expect(subject).toBe("14 new Google reviews for Surf Co");
    expect(html).toContain("and 4 more");
  });

  it("escapes every value that came from Google", () => {
    const { html } = emailFor(
      [review({ reviewerName: '"Eve" & co', comment: "<script>alert(1)</script>" })],
      { locationTitle: "<b>Shop</b>" },
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;Eve&quot; &amp; co");
    expect(html).not.toContain("<b>Shop</b>");
  });

  it("cuts a comment to its first 300 characters", () => {
    const { html } = emailFor([review({ comment: `${"a".repeat(300)}TAIL` })]);
    expect(html).toContain("a".repeat(300));
    expect(html).not.toContain("TAIL");
  });

  it("handles a review with no comment", () => {
    expect(emailFor([review({ comment: undefined })]).html).toContain("No written comment.");
  });

  it("links to the Reviews page and says where to turn the email off", () => {
    const { html } = emailFor([review()], { appBaseUrl: `${BASE}/` });
    expect(html).toContain(`href="${BASE}/reviews"`);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain("Settings, Notifications");
  });

  it("names a reviewer Google does not name, and a rating Google does not give", () => {
    const { html } = emailFor([review({ reviewerName: "", starRating: "STAR_RATING_UNSPECIFIED" })], {
      appBaseUrl: null,
    });
    expect(html).toContain("A Google user");
    expect(html).toContain("No star rating");
    expect(html).not.toContain("<a ");
    expect(html).toContain("Open Reviews in Vibe Socials");
  });

  // The send step re-reads the reviews from Google; when that fails the email
  // still goes out, with the count and the link only.
  it("without excerpts says the count and sends the owner to Reviews", () => {
    const { subject, html } = buildNewReviewsEmail({
      locationTitle: "Surf & Co",
      count: 3,
      reviews: null,
      appBaseUrl: BASE,
    });
    expect(subject).toBe("3 new Google reviews for Surf & Co");
    expect(html).toContain("3 new Google reviews for Surf &amp; Co. Open Reviews to read them.");
    expect(html).not.toContain("<li>");
    expect(html).toContain(`href="${BASE}/reviews"`);
    expect(html).toContain("Settings, Notifications");
  });

  it("without excerpts, for one review, says it", () => {
    const { html } = buildNewReviewsEmail({ locationTitle: "Surf Co", count: 1, reviews: null, appBaseUrl: BASE });
    expect(html).toContain("1 new Google review for Surf Co. Open Reviews to read it.");
  });
});

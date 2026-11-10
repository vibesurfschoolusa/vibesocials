import { describe, expect, it } from "vitest";

import { buildNewReviewsEmail, type NewReviewSummary } from "./newReviewsEmail";

function review(over: Partial<NewReviewSummary> = {}): NewReviewSummary {
  return { starRating: "FIVE", reviewerName: "Dana", comment: "Great lesson!", ...over };
}

const BASE = "https://vibesocials.example";

describe("buildNewReviewsEmail", () => {
  it("says 1 new Google review, singular", () => {
    const email = buildNewReviewsEmail({ locationTitle: "Surf Co", reviews: [review()], appBaseUrl: BASE });
    expect(email.subject).toBe("1 new Google review for Surf Co");
  });

  it("says n new Google reviews, plural", () => {
    const email = buildNewReviewsEmail({
      locationTitle: "Surf Co",
      reviews: [review(), review()],
      appBaseUrl: BASE,
    });
    expect(email.subject).toBe("2 new Google reviews for Surf Co");
  });

  it("lists each review's stars out of 5, name and comment", () => {
    const { html } = buildNewReviewsEmail({
      locationTitle: "Surf Co",
      reviews: [review({ starRating: "FOUR", reviewerName: "Sam", comment: "Fun day" })],
      appBaseUrl: BASE,
    });
    expect(html).toContain("4 out of 5 stars");
    expect(html).toContain("Sam");
    expect(html).toContain("Fun day");
  });

  it("shows 10 of 11 reviews and says and 1 more", () => {
    const reviews = Array.from({ length: 11 }, (_, i) => review({ reviewerName: `Person ${i + 1}` }));
    const { subject, html } = buildNewReviewsEmail({ locationTitle: "Surf Co", reviews, appBaseUrl: BASE });
    expect(subject).toBe("11 new Google reviews for Surf Co");
    expect(html).toContain("Person 10");
    expect(html).not.toContain("Person 11");
    expect(html).toContain("and 1 more");
    expect(html.match(/<li>/g)).toHaveLength(10);
  });

  it("escapes every value that came from Google", () => {
    const { html } = buildNewReviewsEmail({
      locationTitle: "<b>Shop</b>",
      reviews: [review({ reviewerName: '"Eve" & co', comment: "<script>alert(1)</script>" })],
      appBaseUrl: BASE,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;Eve&quot; &amp; co");
    expect(html).not.toContain("<b>Shop</b>");
  });

  it("cuts a comment to its first 300 characters", () => {
    const { html } = buildNewReviewsEmail({
      locationTitle: "Surf Co",
      reviews: [review({ comment: `${"a".repeat(300)}TAIL` })],
      appBaseUrl: BASE,
    });
    expect(html).toContain("a".repeat(300));
    expect(html).not.toContain("TAIL");
  });

  it("handles a review with no comment", () => {
    const { html } = buildNewReviewsEmail({
      locationTitle: "Surf Co",
      reviews: [review({ comment: undefined })],
      appBaseUrl: BASE,
    });
    expect(html).toContain("No written comment.");
  });

  it("links to the Reviews page and says where to turn the email off", () => {
    const { html } = buildNewReviewsEmail({
      locationTitle: "Surf Co",
      reviews: [review()],
      appBaseUrl: `${BASE}/`,
    });
    expect(html).toContain(`href="${BASE}/reviews"`);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain("Settings, Notifications");
  });

  it("names a reviewer Google does not name, and a rating Google does not give", () => {
    const { html } = buildNewReviewsEmail({
      locationTitle: "Surf Co",
      reviews: [review({ reviewerName: "", starRating: "STAR_RATING_UNSPECIFIED" })],
      appBaseUrl: null,
    });
    expect(html).toContain("A Google user");
    expect(html).toContain("No star rating");
    expect(html).not.toContain("<a ");
    expect(html).toContain("Open Reviews in Vibe Socials");
  });
});

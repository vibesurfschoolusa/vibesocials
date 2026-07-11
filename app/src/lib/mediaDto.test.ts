import { describe, expect, it } from "vitest";

import { daysUntilRemoval, toMediaItemDto, type MediaItemDtoSource } from "./mediaDto";

function makeSource(overrides: Partial<MediaItemDtoSource> = {}): MediaItemDtoSource {
  return {
    id: "media-1",
    storageLocation: "https://blob.example/a.png",
    originalFilename: "a.png",
    mimeType: "image/png",
    sizeBytes: 1234,
    baseCaption: "hi",
    perPlatformOverrides: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("toMediaItemDto — lastUsedAt mapping", () => {
  it("maps a Date lastUsedAt to an ISO string", () => {
    const dto = toMediaItemDto(makeSource({ lastUsedAt: new Date("2026-01-05T00:00:00Z") }));
    expect(dto.lastUsedAt).toBe("2026-01-05T00:00:00.000Z");
  });

  it("maps a null lastUsedAt to null", () => {
    const dto = toMediaItemDto(makeSource({ lastUsedAt: null }));
    expect(dto.lastUsedAt).toBeNull();
  });

  it("maps a missing (unselected) lastUsedAt to null, same as explicit null", () => {
    // Mirrors GET /api/media/[id], whose `select` doesn't include lastUsedAt.
    const { lastUsedAt: _omit, ...withoutLastUsedAt } = makeSource({ lastUsedAt: null });
    const dto = toMediaItemDto(withoutLastUsedAt as MediaItemDtoSource);
    expect(dto.lastUsedAt).toBeNull();
  });
});

describe("daysUntilRemoval", () => {
  const RETENTION_DAYS = 30;
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("returns null when lastUsedAt is null (never-posted upload)", () => {
    expect(daysUntilRemoval(null, RETENTION_DAYS, new Date())).toBeNull();
  });

  it("returns null when lastUsedAt is an invalid date string", () => {
    expect(daysUntilRemoval("not-a-date", RETENTION_DAYS, new Date())).toBeNull();
  });

  it("returns 20 when used 10 days ago with a 30-day retention window", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    const lastUsedAt = new Date(now.getTime() - 10 * DAY_MS).toISOString();
    expect(daysUntilRemoval(lastUsedAt, RETENTION_DAYS, now)).toBe(20);
  });

  it("floors at 0 when used 40 days ago (past the 30-day window)", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    const lastUsedAt = new Date(now.getTime() - 40 * DAY_MS).toISOString();
    expect(daysUntilRemoval(lastUsedAt, RETENTION_DAYS, now)).toBe(0);
  });

  it("returns the full retention window when used just now", () => {
    const now = new Date("2026-02-01T00:00:00Z");
    expect(daysUntilRemoval(now.toISOString(), RETENTION_DAYS, now)).toBe(30);
  });
});

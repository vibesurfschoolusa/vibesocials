import { describe, expect, it } from "vitest";

import { readJsonObject } from "./http";

/** A `Request`-shaped stub: the helper only ever calls `request.json()`. */
function requestWithBody(raw: string): Pick<Request, "json"> {
  return new Request("http://localhost/api/x", { method: "POST", body: raw });
}

describe("readJsonObject", () => {
  it("returns a plain JSON object as-is", async () => {
    await expect(readJsonObject(requestWithBody('{"a":1,"b":"x"}'))).resolves.toEqual({
      a: 1,
      b: "x",
    });
  });

  it("returns an empty object for `{}`", async () => {
    await expect(readJsonObject(requestWithBody("{}"))).resolves.toEqual({});
  });

  it.each([
    ["null", "null"],
    ["an array", "[1,2]"],
    ["an empty array", "[]"],
    ["a number", "5"],
    ["a string", '"hello"'],
    ["true", "true"],
    ["false", "false"],
    ["syntactically invalid JSON", "{not json"],
    ["an empty body", ""],
  ])("returns null for %s", async (_label, raw) => {
    await expect(readJsonObject(requestWithBody(raw))).resolves.toBeNull();
  });

  it("returns null when request.json() itself rejects", async () => {
    const request = {
      json: () => Promise.reject(new Error("boom")),
    } as Pick<Request, "json">;
    await expect(readJsonObject(request)).resolves.toBeNull();
  });

  it("returns null for a non-plain object (e.g. a Date) rather than treating it as a body", async () => {
    const request = { json: async () => new Date() } as unknown as Pick<Request, "json">;
    await expect(readJsonObject(request)).resolves.toBeNull();
  });
});

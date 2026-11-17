import { beforeEach, describe, expect, it, vi } from "vitest";

const { consumeMock, releaseMock } = vi.hoisted(() => ({ consumeMock: vi.fn(), releaseMock: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ consumeFixedWindow: consumeMock }));
vi.mock("@/lib/db", () => ({ prisma: { rateLimitEntry: { deleteMany: releaseMock } } }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sendOnceADay, sendOncePer, sendToEach } from "./onceADay";

const KEY = "some-email:2026-11-17";
const RESET_AT = new Date("2026-11-18T00:00:00Z");
const onError = vi.fn();

beforeEach(() => {
  consumeMock.mockReset();
  consumeMock.mockResolvedValue({ allowed: true });
  releaseMock.mockReset();
  releaseMock.mockResolvedValue({ count: 1 });
  onError.mockReset();
});

/** R38 client-journey L2: one rule for every once-a-day email: claim, send, let go unless it went. */
describe("sendOnceADay", () => {
  it("claims the day fail-closed, sends, and keeps the claim when an email went", async () => {
    const send = vi.fn().mockResolvedValue(true);
    await expect(sendOnceADay(KEY, RESET_AT, send, onError)).resolves.toBe("sent");
    expect(consumeMock).toHaveBeenCalledWith({ key: KEY, limit: 1, resetAt: RESET_AT, failClosed: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  // R40 security L3: "skipped" means already sent, so a caller can tell a reached recipient
  // from one the store couldn't answer for.
  it("already claimed today: skipped; a store that couldn't answer: failed; nothing sent, nothing let go", async () => {
    for (const [result, outcome] of [
      [{ allowed: false, retryAfterSeconds: 10 }, "skipped"],
      [{ allowed: false, retryAfterSeconds: 60, unavailable: true }, "failed"],
    ] as const) {
      consumeMock.mockResolvedValueOnce(result);
      const send = vi.fn();
      await expect(sendOnceADay(KEY, RESET_AT, send, onError)).resolves.toBe(outcome);
      expect(send).not.toHaveBeenCalled();
    }
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("no email went (send answered false): the claim is let go", async () => {
    await expect(sendOnceADay(KEY, RESET_AT, async () => false, onError)).resolves.toBe("failed");
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: KEY } });
  });

  it("a read or send that throws: the claim is let go, nothing thrown", async () => {
    await expect(
      sendOnceADay(
        KEY,
        RESET_AT,
        async () => {
          throw new Error("db blip");
        },
        onError,
      ),
    ).resolves.toBe("failed");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "db blip" }));
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: KEY } });
  });

  it("a claim that throws: nothing sent, nothing let go, nothing thrown", async () => {
    consumeMock.mockRejectedValueOnce(new Error("boom"));
    const send = vi.fn();
    await expect(sendOnceADay(KEY, RESET_AT, send, onError)).resolves.toBe("failed");
    expect(send).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
  });
});

/** R39 client-journey L2: the same rule for any window (an hour, a day). */
describe("sendOncePer", () => {
  const HOUR = {
    key: "some-email:2026-11-17T09",
    resetAt: new Date("2026-11-17T10:00:00Z"),
    keysFrom: new Date("2026-11-17T09:00:00Z"),
  };

  it("claims the window fail-closed and keeps it when an email went", async () => {
    await expect(sendOncePer(HOUR, async () => true, onError)).resolves.toBe("sent");
    expect(consumeMock).toHaveBeenCalledWith({ key: HOUR.key, resetAt: HOUR.resetAt, limit: 1, failClosed: true });
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("a failed read or send lets the window go; none sent lets it go too", async () => {
    await expect(
      sendOncePer(
        HOUR,
        async () => {
          throw new Error("db blip");
        },
        onError,
      ),
    ).resolves.toBe("failed");
    await expect(sendOncePer(HOUR, async () => false, onError)).resolves.toBe("failed");
    expect(releaseMock).toHaveBeenCalledTimes(2);
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: HOUR.key } });
  });

  // Resend keeps an idempotency key 24 hours: past that, a reused key stops no second copy.
  it("a window longer than a day: a throw after a send started keeps the claim, while none sent still lets it go", async () => {
    const month = {
      key: "some-email:2026-11",
      resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      keysFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
    };
    await expect(
      sendOncePer(
        month,
        async (sendStarted) => {
          sendStarted();
          throw new Error("network error");
        },
        onError,
      ),
    ).resolves.toBe("failed");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();

    await expect(sendOncePer(month, async () => false, onError)).resolves.toBe("failed");
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: month.key } });
  });

  // R39 lead review L1+L2: nothing can have gone before a send started, whatever the window.
  it("a window longer than a day: a throw before any send started (a failed read) lets the claim go", async () => {
    const month = {
      key: "some-email:2026-11",
      resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      keysFrom: new Date(Date.now() - 24 * 60 * 60 * 1000),
    };
    await expect(
      sendOncePer(
        month,
        async () => {
          throw new Error("db blip");
        },
        onError,
      ),
    ).resolves.toBe("failed");
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: month.key } });
  });

  it("a short window with per-recipient keys: a throw after a send started still lets the claim go", async () => {
    await expect(
      sendOncePer(
        { ...HOUR, perRecipientKeys: true },
        async (sendStarted) => {
          sendStarted();
          throw new Error("network error");
        },
        onError,
      ),
    ).resolves.toBe("failed");
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: HOUR.key } });
  });

  // R40 security L2: with no per-recipient key, a later try after a lost reply is a second copy.
  it("a short window without per-recipient keys: a throw after a send started keeps the claim", async () => {
    await expect(
      sendOncePer(
        HOUR,
        async (sendStarted) => {
          sendStarted();
          throw new Error("network error");
        },
        onError,
      ),
    ).resolves.toBe("failed");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  // R40 lead review: a send marked "not sent" (Resend's 429) certainly didn't go.
  it("a throw marked not sent lets the claim go whatever the keys; unmarked ones are kept", async () => {
    const month = {
      key: "some-email:2026-11",
      resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      keysFrom: null,
    };
    for (const window of [HOUR, month]) {
      releaseMock.mockClear();
      const notSent = Object.assign(new Error("Resend rate limited the send"), { emailNotSent: true });
      await expect(
        sendOncePer(
          window,
          async (sendStarted) => {
            sendStarted();
            throw notSent;
          },
          onError,
        ),
      ).resolves.toBe("failed");
      expect(releaseMock).toHaveBeenCalledWith({ where: { key: window.key } });

      releaseMock.mockClear();
      await expect(
        sendOncePer(
          window,
          async (sendStarted) => {
            sendStarted();
            throw Object.assign(new Error("in flight"), { emailNotSent: "yes" });
          },
          onError,
        ),
      ).resolves.toBe("failed");
      expect(releaseMock).not.toHaveBeenCalled();
    }
  });

  it("a short window without per-recipient keys: a throw before any send started lets the claim go", async () => {
    await expect(
      sendOncePer(
        HOUR,
        async () => {
          throw new Error("db blip");
        },
        onError,
      ),
    ).resolves.toBe("failed");
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: HOUR.key } });
  });

  // R39 lead review L3: within 24 hours each recipient's key already stops a second copy.
  it("a store error on a short window with per-recipient keys: sends once, claims and lets go nothing", async () => {
    const shortKeyed = {
      ...HOUR,
      resetAt: new Date(Date.now() + 30 * 60 * 1000),
      keysFrom: new Date(Date.now() - 30 * 60 * 1000),
      perRecipientKeys: true as const,
    };
    for (const store of [
      () => consumeMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60, unavailable: true }),
      () => consumeMock.mockRejectedValueOnce(new Error("store down")),
    ]) {
      store();
      const send = vi.fn(async () => true);
      await expect(sendOncePer(shortKeyed, send, onError)).resolves.toBe("sent");
      expect(send).toHaveBeenCalledTimes(1);
    }
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("a store error on a long window, or without per-recipient keys: nothing sent", async () => {
    const longKeyed = {
      key: "some-email:2026-11",
      resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      keysFrom: new Date(Date.now() - 60 * 60 * 1000),
      perRecipientKeys: true as const,
    };
    const shortUnkeyed = { ...HOUR, resetAt: new Date(Date.now() + 30 * 60 * 1000), keysFrom: new Date(Date.now() - 30 * 60 * 1000) };
    for (const window of [longKeyed, shortUnkeyed]) {
      consumeMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60, unavailable: true });
      const send = vi.fn(async () => true);
      await expect(sendOncePer(window, send, onError)).resolves.toBe("failed");
      expect(send).not.toHaveBeenCalled();
    }
    expect(releaseMock).not.toHaveBeenCalled();
  });

  // R40 security L1: Resend forgets a key 24 hours after its first use, so a blip may send
  // only when the window's key could not have been used before then.
  describe("a store error with per-recipient keys, by when the key was first usable", () => {
    const HOUR_MS = 60 * 60 * 1000;
    const blip = () => consumeMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60, unavailable: true });

    it("the last day of a month (usable since the 1st): nothing sent", async () => {
      blip();
      const send = vi.fn(async () => true);
      const lastDay = {
        key: "some-email:2026-11",
        resetAt: new Date(Date.now() + 12 * HOUR_MS),
        keysFrom: new Date(Date.now() - 29 * 24 * HOUR_MS),
        perRecipientKeys: true as const,
      };
      await expect(sendOncePer(lastDay, send, onError)).resolves.toBe("failed");
      expect(send).not.toHaveBeenCalled();
    });

    it("a day that could be booked ahead (no bound on when its key was first used): nothing sent on that day", async () => {
      blip();
      const send = vi.fn(async () => true);
      const bookedAhead = {
        key: "some-email:2026-11-17",
        resetAt: new Date(Date.now() + 6 * HOUR_MS),
        keysFrom: null,
        perRecipientKeys: true as const,
      };
      await expect(sendOncePer(bookedAhead, send, onError)).resolves.toBe("failed");
      expect(send).not.toHaveBeenCalled();
    });

    it("the current hour or day (usable only since it began): still sent", async () => {
      for (const [startedMsAgo, endsInMs] of [
        [20 * 60 * 1000, 40 * 60 * 1000],
        [18 * HOUR_MS, 6 * HOUR_MS],
      ]) {
        blip();
        const send = vi.fn(async () => true);
        const current = {
          key: "some-email:now",
          resetAt: new Date(Date.now() + endsInMs),
          keysFrom: new Date(Date.now() - startedMsAgo),
          perRecipientKeys: true as const,
        };
        await expect(sendOncePer(current, send, onError)).resolves.toBe("sent");
        expect(send).toHaveBeenCalledTimes(1);
      }
      expect(releaseMock).not.toHaveBeenCalled();
    });
  });

  it("already claimed: nothing sent", async () => {
    consumeMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60 });
    const send = vi.fn();
    await expect(sendOncePer(HOUR, send, onError)).resolves.toBe("skipped");
    expect(send).not.toHaveBeenCalled();
  });
});

/** R39 client-journey L3: one recipient's failure never stops the email to the next. */
describe("sendToEach", () => {
  it("the first recipient fails retryably: the second is still sent, and it throws so the window is let go", async () => {
    const sendOne = vi.fn(async (to: string) => {
      if (to === "a") throw new Error("Resend rate limited the send");
      return true;
    });
    await expect(sendToEach(["a", "b"], sendOne)).rejects.toThrow("Resend rate limited the send");
    expect(sendOne.mock.calls.map(([to]) => to)).toEqual(["a", "b"]);

    await expect(sendOncePer({ key: KEY, resetAt: RESET_AT, keysFrom: null }, () => sendToEach(["a", "b"], sendOne), onError)).resolves.toBe(
      "failed",
    );
    expect(releaseMock).toHaveBeenCalledWith({ where: { key: KEY } });
  });

  // R40 lead review: one recipient's 429 must not stand for another's unknown outcome.
  it("throws a failure marked not sent only when every failure was", async () => {
    const notSent = () => Object.assign(new Error("429"), { emailNotSent: true });
    const lost = new Error("network error");
    const sendOne = vi.fn(async (to: string) => {
      if (to === "a") throw notSent();
      if (to === "b") throw lost;
      return true;
    });
    await expect(sendToEach(["a", "b"], sendOne)).rejects.toBe(lost);
    await expect(sendToEach(["a", "a"], sendOne)).rejects.toMatchObject({ emailNotSent: true });
    // Someone was sent: the mark is dropped, so the keys' rule decides.
    const refusedAfterSent = await sendToEach(["c", "a"], sendOne).catch((error: unknown) => error);
    expect((refusedAfterSent as { emailNotSent?: unknown }).emailNotSent).toBeUndefined();
  });

  // R40 last look (medium): a 429 after another recipient was sent must not free a window
  // the keys can't cover, or that recipient gets a second copy later.
  describe("a 429 (marked not sent) after a recipient was sent", () => {
    const rateLimited = () => Object.assign(new Error("Resend rate limited the send"), { emailNotSent: true });
    const runOnce = (window: Parameters<typeof sendOncePer>[0], sendOne: (to: string) => Promise<boolean>, to: string[]) =>
      sendOncePer(window, (sendStarted) => sendToEach(to, sendOne, sendStarted), onError);

    it("a window over 24 hours: the claim is kept", async () => {
      const month = { key: "some-email:2026-11", resetAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000), keysFrom: null, perRecipientKeys: true };
      const sendOne = vi.fn(async (to: string) => {
        if (to === "b") throw rateLimited();
        return true;
      });
      await expect(runOnce(month, sendOne, ["a", "b"])).resolves.toBe("failed");
      expect(releaseMock).not.toHaveBeenCalled();
    });

    it("a short window with keys: released, and the next trigger reuses A's key", async () => {
      const keyed = { key: "some-email:2026-11-17T09", resetAt: new Date(Date.now() + 30 * 60 * 1000), keysFrom: new Date(Date.now() - 30 * 60 * 1000), perRecipientKeys: true };
      const keysUsed: string[] = [];
      const sendOne = vi.fn(async (to: string) => {
        keysUsed.push(`some-email/${to}`);
        if (to === "b" && keysUsed.length === 2) throw rateLimited();
        return true;
      });
      await expect(runOnce(keyed, sendOne, ["a", "b"])).resolves.toBe("failed");
      expect(releaseMock).toHaveBeenCalledWith({ where: { key: keyed.key } });
      await expect(runOnce(keyed, sendOne, ["a", "b"])).resolves.toBe("sent");
      // A's own key again, so Resend sends A nothing new; B is reached.
      expect(keysUsed).toEqual(["some-email/a", "some-email/b", "some-email/a", "some-email/b"]);
    });

    it("both recipients 429, or a single one: released, even over 24 hours", async () => {
      const month = { key: "some-email:2026-11", resetAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000), keysFrom: null, perRecipientKeys: true };
      const sendOne = vi.fn(async () => {
        throw rateLimited();
      });
      for (const to of [["a", "b"], ["a"]]) {
        releaseMock.mockClear();
        await expect(runOnce(month, sendOne, to)).resolves.toBe("failed");
        expect(releaseMock).toHaveBeenCalledWith({ where: { key: month.key } });
      }
    });
  });

  it("all went: true, the window is kept", async () => {
    const sendOne = vi.fn(async () => true);
    await expect(sendOncePer({ key: KEY, resetAt: RESET_AT, keysFrom: null }, () => sendToEach(["a", "b"], sendOne), onError)).resolves.toBe(
      "sent",
    );
    expect(sendOne).toHaveBeenCalledTimes(2);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("says a send started before the first send", async () => {
    const events: string[] = [];
    await sendToEach(
      ["a", "b"],
      async (to) => {
        events.push(to);
        return true;
      },
      () => events.push("started"),
    );
    expect(events.slice(0, 2)).toEqual(["started", "a"]);
  });

  it("answers whether any went when none threw", async () => {
    await expect(sendToEach(["a", "b"], async (to) => to === "b")).resolves.toBe(true);
    await expect(sendToEach(["a", "b"], async () => false)).resolves.toBe(false);
    await expect(sendToEach([], async () => true)).resolves.toBe(false);
  });
});

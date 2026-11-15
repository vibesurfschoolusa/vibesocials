import { beforeEach, describe, expect, it, vi } from "vitest";

// R5 new-customer L4 (review): after a sign-in email change, the Stripe
// customers this person pays with follow. Best effort, never blocking.
const { findManyMock, retrieveCustomerMock, updateCustomerEmailMock, loggerWarnMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  retrieveCustomerMock: vi.fn(),
  updateCustomerEmailMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { workspace: { findMany: findManyMock } } }));
vi.mock("./stripeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stripeApi")>()),
  retrieveCustomer: retrieveCustomerMock,
  updateCustomerEmail: updateCustomerEmailMock,
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: loggerWarnMock, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { followEmailChangeInStripe } from "./customerEmail";

const ENV = { STRIPE_SECRET_KEY: "sk_test_example" };

beforeEach(() => {
  for (const mock of [findManyMock, retrieveCustomerMock, updateCustomerEmailMock, loggerWarnMock]) mock.mockReset();
  findManyMock.mockResolvedValue([
    { id: "ws-1", stripeCustomerId: "cus_1" },
    { id: "ws-2", stripeCustomerId: "cus_2" },
  ]);
  retrieveCustomerMock.mockImplementation(async (id: string) =>
    id === "cus_1" ? { id, email: "Old@Example.com" } : { id, email: "partner@example.com" },
  );
  updateCustomerEmailMock.mockResolvedValue({ id: "cus_1" });
});

describe("followEmailChangeInStripe", () => {
  it("does nothing without a Stripe key", async () => {
    await followEmailChangeInStripe({ userId: "u1", from: "old@example.com", to: "new@example.com" }, {});
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("reads only the workspaces this person owns that have a customer", async () => {
    await followEmailChangeInStripe({ userId: "u1", from: "old@example.com", to: "new@example.com" }, ENV);
    expect(findManyMock.mock.calls[0][0].where).toEqual({
      stripeCustomerId: { not: null },
      members: { some: { userId: "u1", role: "owner" } },
    });
  });

  it("updates only the customers whose email is this person's old address", async () => {
    await followEmailChangeInStripe({ userId: "u1", from: "old@example.com", to: "new@example.com" }, ENV);
    expect(updateCustomerEmailMock).toHaveBeenCalledTimes(1);
    const [id, email, key] = updateCustomerEmailMock.mock.calls[0];
    expect(id).toBe("cus_1");
    expect(email).toBe("new@example.com");
    expect(key).not.toContain("new@example.com");
  });

  it("skips a deleted customer", async () => {
    retrieveCustomerMock.mockResolvedValue({ id: "cus_1", deleted: true });
    await followEmailChangeInStripe({ userId: "u1", from: "old@example.com", to: "new@example.com" }, ENV);
    expect(updateCustomerEmailMock).not.toHaveBeenCalled();
  });

  it("never throws, and logs a failure without either address", async () => {
    retrieveCustomerMock.mockRejectedValueOnce(new Error("Stripe answered 500"));
    updateCustomerEmailMock.mockRejectedValue(new Error("Stripe answered 500"));
    findManyMock.mockResolvedValueOnce([
      { id: "ws-1", stripeCustomerId: "cus_x" },
      { id: "ws-2", stripeCustomerId: "cus_1" },
    ]);
    await expect(
      followEmailChangeInStripe({ userId: "u1", from: "old@example.com", to: "new@example.com" }, ENV),
    ).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(loggerWarnMock.mock.calls);
    expect(logged).not.toContain("old@example.com");
    expect(logged).not.toContain("new@example.com");
    expect(logged).toContain("ws-1");

    findManyMock.mockRejectedValueOnce(new Error("db down"));
    await expect(
      followEmailChangeInStripe({ userId: "u1", from: "old@example.com", to: "new@example.com" }, ENV),
    ).resolves.toBeUndefined();
  });
});

import type { WorkspaceContext } from "@/lib/workspace";

/**
 * Shared `getWorkspaceContext()` fixture builder for route tests (Team
 * Workspaces, Task 4). Every rescoped route under `posts/` and `media/` mocks
 * `@/lib/workspace`'s `getWorkspaceContext` the same way, so this factory
 * replaces the old per-file `USER = { id, email }` constant — 8 test files
 * need it (posts/route.test.ts, posts/route.get.test.ts,
 * posts/[postJobId]/route.test.ts + cancel/publish/retry, media/route.test.ts,
 * media/[id]/route.test.ts), well past the design doc §8 "shared
 * `mockWorkspaceContext` helper" threshold — see task-4-report.md for the
 * shared-vs-inline call.
 *
 * `user` is cast rather than filled out field-for-field: `WorkspaceContext.user`
 * is the FULL Prisma `User` row (passwordHash, notifyOnPostComplete,
 * createdAt, updatedAt, ...), but every route this helper serves only ever
 * reads `user.id` (and GET /api/posts' `createdBy` mapping reads the
 * *joined* `user.name`/`email` off a separate select, not this object) — the
 * routes are exercised here as mocked units, not through real Prisma types.
 */
export function makeWorkspaceContext(
  overrides: Partial<{
    userId: string;
    email: string;
    name: string | null;
    workspaceId: string;
    workspaceName: string;
    role: WorkspaceContext["role"];
    memberCount: number;
    /** Approval workflow — defaults off, matching the schema default. */
    requireApproval: boolean;
  }> = {},
): WorkspaceContext {
  return {
    user: {
      id: overrides.userId ?? "user-1",
      email: overrides.email ?? "owner@example.com",
      name: overrides.name ?? "Owner",
    } as WorkspaceContext["user"],
    workspace: {
      id: overrides.workspaceId ?? "ws-1",
      name: overrides.workspaceName ?? "Acme",
      companyWebsite: null,
      defaultHashtags: null,
      requireApproval: overrides.requireApproval ?? false,
    },
    role: overrides.role ?? "owner",
    memberCount: overrides.memberCount ?? 1,
  };
}

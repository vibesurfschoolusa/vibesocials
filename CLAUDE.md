# Vibe Socials: rules for every agent working in this repository

Vibe Socials publishes one post to many social platforms. The app is the Next.js project in `app/`. It is live at vibesocials.wtf, and platform reviewers and real accounts use that site.

## Never

- Never read, print or use `app/.env.local`. It holds production secrets.
- Never connect to the production database, and never run a `prisma` command that reaches a database (`migrate`, `db push`, `studio`, `db seed`).
- Never run `next build`, `next start`, `next dev`, `npm run build`, `npm run dev` or Playwright on this machine. They read `app/.env.local`.
- Never push or merge to `main`. Only the lead session releases.
- Never add a dependency without the lead's say-so.
- Never write secrets, tokens or personal data into code, tests, logs or reports.

## Commands

Run these from `app/`. The database URL below is a dummy that nothing listens on; the unit tests do not need a database.

```bash
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5499/unused" npx vitest run            # all tests
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5499/unused" npx vitest run src/path   # one file or folder
npx tsc --noEmit -p .
npx eslint src
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5499/unused" npx prisma validate
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5499/unused" npx prisma generate       # after a schema change
```

## How the code is built

- Tests sit beside the code as `*.test.ts`. Write the test first and watch it fail.
- The customer is a `Workspace`. Every query on customer data is scoped to the workspace from `getWorkspaceContext()` in `src/lib/workspace.ts`. Owner-only actions check the role.
- A database change is a new folder `app/prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql` plus the matching edit to `app/prisma/schema.prisma`. Changes are additive: new nullable columns, new tables, new indexes. The release runs the migration on the live database while the previous code is still serving, so old code must keep working with the new schema.
- Routes guard abuse with `src/lib/rateLimit.ts`.
- Background work is Inngest functions in `src/server/jobs/`. The plan allows 50,000 executions a month and about 28,000 are already used, so a new scheduled job runs at most daily and does its work in as few steps as it can.
- Text the user reads is plain and specific: say what happened and what to do next.
- Comments explain why, not what. Files end in LF, never CRLF.

## Releasing (lead only)

Feature branch, draft pull request, CI green, fast-forward `main`, push, wait for the production deployment, then check the live site.

import Link from "next/link";

/**
 * Public data-deletion instructions.
 *
 * Meta's App Review requires a reachable "Data Deletion Instructions URL", and
 * TikTok/Google reviewers look for the same thing. It must be publicly readable
 * WITHOUT signing in — hence the `/data-deletion` prefix in both
 * `middleware.ts`'s isPublicPath and `nav.ts`'s PUBLIC_ROUTE_PREFIXES (the
 * latter also keeps the marketing-style layout, with no app shell).
 */
export const metadata = {
  title: "Delete your data | Vibe Socials",
  description:
    "How to disconnect a social account or permanently delete your Vibe Socials account and all associated data.",
};

const SUPPORT_EMAIL = "info@vibesurfschool.com";

export default function DataDeletionPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-3xl rounded-[calc(var(--radius)+0.125rem)] border border-border bg-card p-8 text-card-foreground shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-foreground">Delete your data</h1>
          <Link
            href="/"
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Back to Vibe Socials
          </Link>
        </div>

        <p className="mb-6 text-sm text-muted-foreground">
          You can remove your data from Vibe Socials at any time. Choose whichever of the
          following matches what you want to delete.
        </p>

        <div className="space-y-6 text-sm text-muted-foreground">
          <section>
            <h2 className="mb-1 text-sm font-semibold text-foreground">
              1. Disconnect a single social account
            </h2>
            <p>
              Sign in, open <strong>Settings</strong>, and choose <strong>Disconnect</strong> next
              to the platform you want to remove. This immediately deletes the stored access and
              refresh tokens for that platform, along with the publishing history tied to that
              connection. Posts already published on the platform itself are not affected — remove
              those from the platform directly.
            </p>
          </section>

          <section>
            <h2 className="mb-1 text-sm font-semibold text-foreground">
              2. Delete your entire account
            </h2>
            <p className="mb-2">
              Email{" "}
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href={`mailto:${SUPPORT_EMAIL}?subject=Delete%20my%20Vibe%20Socials%20account`}
              >
                {SUPPORT_EMAIL}
              </a>{" "}
              from the address you registered with, asking us to delete your account. We action
              these within 30 days and confirm by email when it is done.
            </p>
            <p>Deleting your account permanently removes:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Your account record, including email address and password hash.</li>
              <li>
                Every social connection you authorized, including all stored access and refresh
                tokens.
              </li>
              <li>Your uploaded media, along with the underlying stored files.</li>
              <li>Your posts, scheduled posts, drafts, and their per-platform results.</li>
              <li>Any performance metrics collected for your posts.</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-1 text-sm font-semibold text-foreground">
              3. Revoke access from the platform&apos;s side
            </h2>
            <p>
              You can also revoke Vibe Socials&apos; access from the platform directly — for
              example in Google Account permissions, Facebook Business Integrations, TikTok
              security settings, or LinkedIn permitted services. Doing so stops Vibe Socials from
              publishing on your behalf immediately. To remove the data we have already stored,
              follow step 1 or 2 above as well.
            </p>
          </section>

          <section>
            <h2 className="mb-1 text-sm font-semibold text-foreground">Questions</h2>
            <p>
              Contact{" "}
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href={`mailto:${SUPPORT_EMAIL}`}
              >
                {SUPPORT_EMAIL}
              </a>
              . See also our{" "}
              <Link className="underline underline-offset-2 hover:text-foreground" href="/privacy">
                Privacy Policy
              </Link>{" "}
              and{" "}
              <Link className="underline underline-offset-2 hover:text-foreground" href="/terms">
                Terms of Service
              </Link>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

import Link from "next/link";

export default function PrivacyPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50">
      <div className="w-full max-w-3xl rounded-lg bg-white p-8 shadow">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Privacy Policy</h1>
          <Link href="/" className="text-xs text-zinc-600 underline">
            Back to Vibe Socials
          </Link>
        </div>
        <p className="mb-4 text-sm text-zinc-700">
          This Privacy Policy describes how Vibe Socials (the "Service") handles information
          about you. This is an early-stage tool intended for limited use by the owner and invited
          testers.
        </p>
        <div className="space-y-3 text-sm text-zinc-700">
          <section>
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">1. Information we store</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>Account information such as your email address and a hashed password.</li>
              <li>
                Connection information for social platforms you choose to connect (for example,
                access tokens, refresh tokens, token expiry, and basic account identifiers like
                open_id or email).
              </li>
              <li>
                Media metadata and storage paths for videos or images you upload through the
                Service.
              </li>
              <li>
                Records of posting jobs and status information returned by integrated platforms.
              </li>
            </ul>
          </section>
          <section>
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">2. How we use this information</h2>
            <p>We use the information described above to:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Authenticate you and manage your account.</li>
              <li>
                Connect to third-party APIs (such as TikTok or Google Business Profile) on your
                behalf when you explicitly initiate a post or other action.
              </li>
              <li>
                Store media and captions so you can reuse them across platforms and view posting
                history.
              </li>
            </ul>
          </section>
          <section>
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">3. Third-party services</h2>
            <p>
              When you connect a social account, access tokens are stored on the server side and
              used only to call that platform&apos;s APIs on your behalf. Your use of each platform is
              also governed by its own terms and privacy policy. We do not control how those
              platforms handle your data once it is sent to them.
            </p>
          </section>
          <section>
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">4. Data retention</h2>
            <p>
              Data is stored for as long as your account exists or as needed to operate the Service.
              You can request removal of your account and associated data by contacting the owner of
              this project.
            </p>
          </section>
          <section>
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">5. Security</h2>
            <p>
              This is a development-stage project and does not claim production-grade security.
              Reasonable measures are taken to restrict access to stored data, but there is always
              some risk when using early-stage software.
            </p>
          </section>
          <section>
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">6. Changes</h2>
            <p>
              This policy may be updated over time. If you continue using the Service after changes
              are made, you accept the updated policy.
            </p>
          </section>
          <section>
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">7. Contact</h2>
            <p>
              If you have questions about this Privacy Policy, please contact the developer or owner
              of this project through the channels where you obtained access to Vibe Socials.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

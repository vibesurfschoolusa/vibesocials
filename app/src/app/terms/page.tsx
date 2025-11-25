import Link from "next/link";

export default function TermsPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50">
      <div className="w-full max-w-3xl rounded-lg bg-white p-8 shadow">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Terms of Service</h1>
          <Link href="/" className="text-xs text-zinc-600 underline">
            Back to Vibe Socials
          </Link>
        </div>
        <p className="mb-4 text-sm text-zinc-700">
          These Terms of Service ("Terms") govern your use of Vibe Socials (the "Service").
          By accessing or using the Service, you agree to be bound by these Terms.
        </p>
        <div className="space-y-3 text-sm text-zinc-700">
          <section>
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">1. Purpose of the Service</h2>
            <p>
              Vibe Socials helps you upload media and manage social posting workflows across
              supported third-party platforms (such as TikTok and Google Business Profile).
            </p>
          </section>
          <section>
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">2. Your responsibilities</h2>
            <ul className="list-disc space-y-1 pl-5">
              <li>You are responsible for any content you upload or publish through the Service.</li>
              <li>
                You must comply with all applicable laws and the terms, policies, and guidelines of
                each third-party platform you connect.
              </li>
              <li>
                You must not use the Service to share illegal, harmful, hateful, or infringing
                content.
              </li>
            </ul>
          </section>
          <section>
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">3. Third-party platforms</h2>
            <p>
              The Service integrates with third-party platforms but is not endorsed by or affiliated
              with them. Your use of those platforms remains subject to their own terms and
              policies. We cannot control or guarantee how those platforms handle your data once it
              is transmitted to them.
            </p>
          </section>
          <section>
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">4. No guarantee of availability</h2>
            <p>
              The Service is provided on an experimental and "as-is" basis. We do not guarantee
              uninterrupted availability, error-free operation, or long-term storage of any
              content. You should always keep your own backups of important media and captions.
            </p>
          </section>
          <section>
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">5. Changes to the Service</h2>
            <p>
              Features, integrations, and supported platforms may change or be removed at any time.
              We may update these Terms from time to time; if you continue using the Service after
              updates take effect, you agree to the updated Terms.
            </p>
          </section>
          <section>
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">6. Limitation of liability</h2>
            <p>
              To the maximum extent permitted by law, the Service is provided without warranties of
              any kind and we are not liable for any indirect, incidental, or consequential
              damages, loss of data, or loss of access to third-party accounts arising from your use
              of the Service.
            </p>
          </section>
          <section>
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">7. Contact</h2>
            <p>
              If you have questions about these Terms, please contact the developer or owner of
              this project through the channels where you obtained access to Vibe Socials.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

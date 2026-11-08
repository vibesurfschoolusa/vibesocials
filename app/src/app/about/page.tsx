import Link from "next/link";

import { LegalPage, LegalSection } from "@/components/legal-page";
import { buttonVariants } from "@/components/ui/button";
import { PLATFORM_ORDER, platformLabel } from "@/lib/platforms";
import { OPERATOR_LOCATION, OPERATOR_NAME, PRODUCT_NAME, SUPPORT_EMAIL } from "@/lib/siteInfo";

export const metadata = {
  title: "About | Vibe Socials",
  description:
    "Vibe Socials helps small businesses and creators publish one photo or video to all their social media accounts at once.",
};

export default function AboutPage() {
  return (
    <LegalPage
      title={`About ${PRODUCT_NAME}`}
      showUpdated={false}
      intro={
        <p>
          {PRODUCT_NAME} is a web app for small businesses and creators who post the same moment to
          several social networks. Upload a photo or video once, write a caption (or let AI draft
          one), choose where it goes, and publish now or schedule it.
        </p>
      }
    >
      <LegalSection title="Who it's for">
        <p>
          Local businesses, tour and activity operators, shops and creators who don&apos;t have time
          to post the same thing seven times. Anyone can sign up, connect their own accounts and
          invite their team.
        </p>
      </LegalSection>

      <LegalSection title="Where you can post">
        <ul className="flex flex-wrap gap-2">
          {PLATFORM_ORDER.map((platform) => (
            <li key={platform} className="rounded-full border border-border px-3 py-1 text-xs">
              {platformLabel(platform)}
            </li>
          ))}
        </ul>
      </LegalSection>

      <LegalSection title="How it works">
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            Create an account, then connect each platform with that platform&apos;s own sign-in
            screen. You approve exactly what {PRODUCT_NAME} may do, and can disconnect at any time.
          </li>
          <li>
            Upload a photo or video and write a caption. For each platform you see a preview, and
            you choose its settings: for TikTok, who can view the post, whether comments, duets and
            stitches are allowed, and whether the post promotes a brand.
          </li>
          <li>
            Publish now or schedule it. {PRODUCT_NAME} posts through each platform&apos;s official
            API and shows you where every post went, with a link to it.
          </li>
        </ol>
      </LegalSection>

      <LegalSection title="Who runs it">
        <p>
          {PRODUCT_NAME} is built and operated by {OPERATOR_NAME}, {OPERATOR_LOCATION}, for any
          business or creator who wants to post everywhere without doing it seven times.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <div id="contact">
          <p>
            Questions, support or privacy requests:{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-2">
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </div>
      </LegalSection>

      <div className="flex flex-wrap gap-3 pt-2">
        <Link href="/register" className={buttonVariants({ variant: "primary" })}>
          Create free account
        </Link>
        <Link href="/login" className={buttonVariants({ variant: "outline" })}>
          Log in
        </Link>
      </div>
    </LegalPage>
  );
}

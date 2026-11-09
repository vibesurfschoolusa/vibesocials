import Link from "next/link";

import { LegalPage, LegalSection } from "@/components/legal-page";
import { OPERATOR_LOCATION, OPERATOR_NAME, PRODUCT_NAME, SUPPORT_EMAIL } from "@/lib/siteInfo";

export const metadata = {
  title: "Terms of Service | Vibe Socials",
  description: "The terms for using Vibe Socials to publish posts to your connected social media accounts.",
};

const mail = <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-2">{SUPPORT_EMAIL}</a>;

const externalLink = (href: string, label: string) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
    {label}
  </a>
);

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      intro={
        <p>
          These Terms govern your use of {PRODUCT_NAME} (the &quot;Service&quot;), operated by{" "}
          {OPERATOR_NAME}, {OPERATOR_LOCATION} (&quot;we&quot;). By creating an account or using the
          Service, you agree to them.
        </p>
      }
    >
      <LegalSection title="1. The Service">
        <p>
          {PRODUCT_NAME} lets businesses and creators upload a photo or video once, write or
          AI-assist a caption, and publish or schedule it to the social media accounts they connect:
          TikTok, Instagram, Facebook Pages, YouTube, LinkedIn, X and Google Business Profile.
          Anyone aged 18 or over can create an account; a workspace can be shared with teammates.
        </p>
      </LegalSection>

      <LegalSection title="2. Your account">
        <ul className="list-disc space-y-1 pl-5">
          <li>Keep your sign-in details secure and tell us about any unauthorized use.</li>
          <li>Connect only accounts you own or are authorized to manage.</li>
          <li>Workspace owners decide who may post to the workspace&apos;s connected accounts.</li>
        </ul>
      </LegalSection>

      <LegalSection title="3. Your content">
        <p>
          You keep all rights to what you upload. You give us permission to store, process and send
          your content only as needed to publish it where and when you choose. Nothing is posted
          unless you create the post and confirm it. You are responsible for your content and for
          having the rights to it, including any music.
        </p>
      </LegalSection>

      <LegalSection title="4. Platform rules">
        <p>
          You must follow the terms and policies of each platform you post to. For TikTok, that
          includes TikTok&apos;s{" "}
          {externalLink("https://www.tiktok.com/legal/page/us/terms-of-service/en", "Terms of Service")},{" "}
          {externalLink("https://www.tiktok.com/community-guidelines", "Community Guidelines")},{" "}
          {externalLink("https://www.tiktok.com/legal/page/global/music-usage-confirmation/en", "Music Usage Confirmation")}{" "}
          and, for paid partnerships,{" "}
          {externalLink("https://www.tiktok.com/legal/page/global/bc-policy/en", "Branded Content Policy")}.
          If your content promotes a brand, product or service, disclose it using the settings the
          Service shows for that platform.
        </p>
      </LegalSection>

      <LegalSection title="5. Acceptable use">
        <p>
          Don&apos;t use the Service to post illegal, hateful, harassing, deceptive or infringing
          content, to send spam or mass unsolicited mentions, to impersonate others, or to get
          around a platform&apos;s limits. Don&apos;t try to access other workspaces or interfere
          with the Service.
        </p>
      </LegalSection>

      <LegalSection title="6. Third-party platforms">
        <p>
          {PRODUCT_NAME} is not affiliated with or endorsed by TikTok, Meta, Google, LinkedIn or X.
          Each platform decides whether and how your post appears, and may change its features or
          limits at any time.
        </p>
        <p className="mt-2">
          {PRODUCT_NAME} uses YouTube API Services. If you connect YouTube, you agree to be bound by
          the{" "}
          <a href="https://www.youtube.com/t/terms" className="underline underline-offset-2">YouTube Terms of Service</a>.
        </p>
      </LegalSection>

      <LegalSection title="7. Fees">
        <p>
          The Service is currently free. If we introduce paid plans, we will tell you and show the
          price before anything is charged.
        </p>
      </LegalSection>

      <LegalSection title="8. Availability and changes">
        <p>
          We work to keep the Service running and your posts reliable, but we can&apos;t guarantee
          uninterrupted operation. We may change features, and will post changes to these Terms here
          with a new date.
        </p>
      </LegalSection>

      <LegalSection title="9. Ending your use">
        <p>
          You can stop using the Service and delete your account at any time (see{" "}
          <Link href="/data-deletion" className="underline underline-offset-2">Delete your data</Link>
          ). We may suspend accounts that break these Terms or a platform&apos;s rules.
        </p>
      </LegalSection>

      <LegalSection title="10. Disclaimer and liability">
        <p>
          The Service is provided &quot;as is&quot;. To the extent the law allows, we are not liable for
          indirect or consequential losses, lost data, or a platform&apos;s actions on your account,
          and our total liability is limited to the amount you paid us in the 12 months before the
          claim (currently zero).
        </p>
      </LegalSection>

      <LegalSection title="11. Governing law">
        <p>These Terms are governed by the laws of the State of Florida, United States.</p>
      </LegalSection>

      <LegalSection title="12. Contact">
        <p>
          {OPERATOR_NAME} ({PRODUCT_NAME}), {OPERATOR_LOCATION}. Email: {mail}.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

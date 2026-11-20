import Link from "next/link";

import { LegalPage, LegalSection } from "@/components/legal-page";
import { billingEnabled } from "@/lib/billing";
import { PRIVACY_PAYMENTS } from "@/lib/billingTerms";
import { privacyLastUpdated } from "@/lib/legalLastUpdated";
import { OPERATOR_LOCATION, OPERATOR_NAME, PRODUCT_NAME, SUPPORT_EMAIL } from "@/lib/siteInfo";

export const metadata = {
  title: "Privacy Policy | Vibe Socials",
  description:
    "What Vibe Socials collects, how it is used to publish your posts, who processes it, how long it is kept, and how to delete it.",
};

const mail = <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-2">{SUPPORT_EMAIL}</a>;

// Billing on adds a paragraph and, as section 10 promises for any change, a new
// date (src/lib/billingTerms.ts). F7 (2026-11-14): the policy names every number
// the app reads back, what clients send through links and what goes to the AI
// provider, so it carries its own date (privacyLastUpdated), billing on or off.
export default function PrivacyPage() {
  const billing = billingEnabled();
  const intro = (
    <p>
      {PRODUCT_NAME} (&quot;we&quot;, &quot;the Service&quot;) is a web app that lets businesses and
      creators upload a photo or video once and publish it to the social media accounts they
      connect. {PRODUCT_NAME} is operated by {OPERATOR_NAME}, {OPERATOR_LOCATION}. This policy
      explains what we collect, why, who processes it, and how you can delete it.
    </p>
  );
  return (
    <LegalPage
      title="Privacy Policy"
      // LegalPage prints the shared date; this page prints its own (privacyLastUpdated).
      showUpdated={false}
      intro={
        <>
          <p className="mb-4 text-xs text-muted-foreground">Last updated: {privacyLastUpdated(billing)}</p>
          {intro}
        </>
      }
    >
      <LegalSection title="1. Information we collect">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">Account information:</strong> your name, email
            address and a hashed password (or your Google sign-in, if you choose it), your workspace
            and the teammates you invite.
          </li>
          <li>
            <strong className="text-foreground">Content you upload:</strong> the photos and videos you
            add, your captions, and the post settings you choose.
          </li>
          <li>
            <strong className="text-foreground">Connected platform accounts:</strong> when you connect
            a platform, we receive the access permissions you approve on that platform&apos;s own
            sign-in screen, your account&apos;s identifier and display name, and the access and
            refresh tokens that let us publish for you.
          </li>
          <li>
            <strong className="text-foreground">Publishing results:</strong> the post IDs, links,
            statuses and error messages each platform returns.
          </li>
          <li>
            <strong className="text-foreground">Post numbers:</strong> for posts made through the
            Service, the numbers each platform reports for them: views, likes and comments on YouTube;
            likes and comments on Instagram; reactions, comments and shares on Facebook; views, clicks,
            likes, comments and shares on LinkedIn; views, saves and clicks on Pinterest. These are
            totals only: we do not read who reacted, commented or clicked, or what a comment says. We
            read no numbers from X, TikTok or Google Business Profile posts.
          </li>
          <li>
            <strong className="text-foreground">Google listing numbers:</strong> if you choose a
            Google Business Profile location, its daily search and Maps views, calls, direction requests
            and website clicks, as Google reports them.
          </li>
          <li>
            <strong className="text-foreground">Google Business reviews:</strong> if you connect a
            Google Business Profile, the reviews you open in the Service and the replies you send. Once
            a day we also check the listing for new reviews, to email you about them; we keep only when
            the newest review we saw was written, not the reviews.
          </li>
          <li>
            <strong className="text-foreground">What your clients send through your links:</strong> through
            an upload link, the photos and videos they send, and the name and note they add; through a
            review link, whether they approve each post and what they ask to have changed.
          </li>
          <li>
            <strong className="text-foreground">Technical information:</strong> basic request data
            such as IP address and browser type in short-lived server logs, used for security and to
            prevent abuse.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="2. How we use it">
        <p>Only to provide the Service you asked for:</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>to sign you in and run your account and workspace;</li>
          <li>to publish or schedule the posts you create, to the platforms you choose, when you choose;</li>
          <li>to show you where each post went, keep your connections working, and email you when a post finishes (you can turn these emails off in Settings);</li>
          <li>to show you how your posts and your Google listing are doing: the post and listing numbers show in the app, in monthly reports, in emails and on the client review link;</li>
          <li>to suggest captions with AI, automatically when you add a photo or video or when you ask, to describe photos for screen readers, and to suggest review replies when you ask.</li>
        </ul>
        <p className="mt-2">
          What goes to our AI provider: the photos and still frames of videos it is asked to caption or
          describe; your captions, when you ask it to improve one; whenever it writes or improves a
          caption (on Create and in Add many), recent captions from this workspace&apos;s posts, and in Add
          many the batch&apos;s other captions, so the AI does not repeat them; your brand voice notes; and, when you ask for a reply
          suggestion, the review&apos;s text, star rating and the reviewer&apos;s display name. On the
          Create page, untick &quot;Generate a caption when media is added&quot; and nothing is sent
          until you ask. Turn off Write captions with AI in Add many and no photo or video is sent:
          rows start with an empty caption box and photos are not described automatically.
        </p>
        <p className="mt-2">
          We do not sell your information, use it for advertising, or post anything you did not
          create and confirm.
        </p>
      </LegalSection>

      <LegalSection title="3. TikTok">
        <p>When you connect TikTok, you approve these permissions on TikTok&apos;s own screen:</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">user.info.basic:</strong> your TikTok account&apos;s
            ID (open ID) and display name, shown so you know which account a post goes to.
          </li>
          <li>
            <strong className="text-foreground">video.publish:</strong> posting the
            videos you choose to your account, with the privacy, interaction and content-disclosure
            settings you select for each post. Before each post we ask TikTok for your account&apos;s
            current posting options (for example, which privacy levels you can use) and its name and
            profile picture, which the Create page shows.
          </li>
        </ul>
        <p className="mt-2">
          We do not read your TikTok videos, followers, likes or messages. Disconnecting TikTok in
          Settings deletes the tokens we hold; you can also remove {PRODUCT_NAME}&apos;s access from
          your TikTok app settings at any time.
        </p>
      </LegalSection>

      <LegalSection title="4. YouTube, Google and other platforms">
        <p>
          {PRODUCT_NAME} uses YouTube API Services. By connecting YouTube you agree to the{" "}
          <a href="https://www.youtube.com/t/terms" className="underline underline-offset-2">YouTube Terms of Service</a>, and
          Google&apos;s handling of your data is described in the{" "}
          <a href="https://policies.google.com/privacy" className="underline underline-offset-2">Google Privacy Policy</a>. When you
          connect YouTube or Google Business Profile, you approve these permissions on Google&apos;s
          own screen, and we use them only as follows:
        </p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>
            <strong className="text-foreground">YouTube upload:</strong> uploading the videos you
            choose to your channel, with the title, description and privacy you set.
          </li>
          <li>
            <strong className="text-foreground">YouTube read-only:</strong> your channel&apos;s name,
            shown in Settings, and the view, like and comment counts of videos you posted through{" "}
            {PRODUCT_NAME}, shown on your dashboard.
          </li>
          <li>
            <strong className="text-foreground">Google Business Profile:</strong> creating the posts
            you publish, adding your videos to your profile&apos;s photos and videos, showing your
            reviews and posting the replies you write or approve, and reading the listing numbers
            described in section 1.
          </li>
        </ul>
        <p className="mt-2">
          {PRODUCT_NAME}&apos;s use and transfer of information received from Google APIs adheres
          to the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy" className="underline underline-offset-2">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. We never sell Google user data, use it for
          advertising, or use it to train AI models. A review&apos;s text goes to our AI provider only
          when you ask for a reply suggestion. You can revoke {PRODUCT_NAME}&apos;s access at any time
          in your{" "}
          <a href="https://security.google.com/settings/security/permissions" className="underline underline-offset-2">
            Google account permissions
          </a>
          ; disconnecting in Settings deletes the tokens we hold and the numbers read from that account.
        </p>
        <p className="mt-2">
          The same approach applies to Facebook Pages and Instagram (Meta), LinkedIn, Pinterest and X: we
          request only the permissions needed to publish your posts and to read back the post numbers
          described in section 1, and use them only for that.
          Each platform&apos;s own terms and privacy policy also apply to what you post there.
        </p>
        <p className="mt-2">
          For LinkedIn, you approve two permissions on LinkedIn&apos;s own screen: posting as your
          company page, and finding the pages you administer so you can choose one. We store the
          page&apos;s ID and name to show it in Settings and to publish to it. For the posts made
          through the Service we read their totals of views, clicks, likes, comments and shares, not
          who reacted or what a comment says. We do not read your LinkedIn profile or your connections.
        </p>
        <p className="mt-2">
          For Pinterest, you approve on Pinterest&apos;s own screen: creating Pins, and reading your
          boards and your username. We read your list of boards when you connect, so you can choose
          the board your Pins go on. We store your username and that board&apos;s ID and name, to show
          them in Settings and to publish to the board, and the ID of each Pin we create, to link to
          it. For those Pins we also read their views, saves and clicks. We do not read your other
          Pins, your followers or your messages, and we never save other people&apos;s Pins, follow accounts or
          comment for you. You can remove{" "}
          {PRODUCT_NAME}&apos;s access at any time in your Pinterest settings under Security; disconnecting
          in Settings deletes the tokens, the Pinterest details and the Pins&apos; numbers we hold.
        </p>
      </LegalSection>

      <LegalSection title="5. Who processes your information">
        <p>We use these service providers, only to run the Service:</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>Vercel (hosting and media file storage);</li>
          <li>Neon (database);</li>
          <li>Inngest (running scheduled and background publishing jobs);</li>
          <li>Resend (account and notification emails);</li>
          <li>xAI or OpenAI (AI caption and reply suggestions, for the media and text involved).</li>
        </ul>
        {/* Billing on only (src/lib/billingTerms.ts); with it off nothing renders here. */}
        {billing ? <p className="mt-2">{PRIVACY_PAYMENTS}</p> : null}
        <p className="mt-2">
          Your content is also sent to each social platform you choose to post to. We share
          information with authorities only where the law requires it.
        </p>
      </LegalSection>

      <LegalSection title="6. How long we keep it">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Photos and videos you have posted are deleted 30 days after they were last used in a post.
            Uploads you keep in your media library without posting stay until you delete them there
            or delete your account.
          </li>
          <li>Platform tokens are deleted when you disconnect that platform.</li>
          <li>
            Post numbers are read once a day for posts published in the last 60 days, and kept while
            that platform stays connected. YouTube numbers are read about every hour instead; YouTube
            numbers not refreshed for 30 days are deleted.
          </li>
          <li>
            Google listing numbers are read once a day, the first time for the last 90 days, and kept
            while Google Business Profile stays connected.
          </li>
          <li>
            Disconnecting a platform in Settings deletes the post numbers read from it; disconnecting
            Google Business Profile also deletes the listing&apos;s numbers.
          </li>
          <li>
            A connected LinkedIn page&apos;s name is read again from LinkedIn regularly while the
            connection works. A name not refreshed for eight weeks is deleted; disconnecting LinkedIn
            deletes it at once.
          </li>
          <li>
            A client&apos;s name and note stay with the file they sent, in your Media library, until you
            delete it there. A change request stays with its post until the post is scheduled again or
            deleted.
          </li>
          <li>Your account, posts and publishing history are kept until you delete your account.</li>
          <li>
            When you change your sign-in email, we keep your previous address for 72 hours, so that a
            link sent to it can undo the change; it is deleted within a day after the 72 hours.
          </li>
          <li>
            Deleting a workspace deletes everything in it: its posts, media, connections, post and
            listing numbers, and what clients sent through its links.
          </li>
          <li>
            A count of posts per person and per X account, and of workspaces each person created, used
            for the daily and monthly limits, is kept for 62 days, also after a workspace or account is
            deleted.
          </li>
          <li>Server logs are kept for a short time, typically days.</li>
        </ul>
      </LegalSection>

      <LegalSection title="7. Your choices and deletion">
        <p>
          You can disconnect any platform in Settings at any time. To delete your account and all
          associated data, follow the steps on our{" "}
          <Link href="/data-deletion" className="underline underline-offset-2">data deletion page</Link>{" "}
          or email {mail}. You can also ask us for a copy of your information or to correct it.
        </p>
      </LegalSection>

      <LegalSection title="8. Security">
        <p>
          All traffic is encrypted (HTTPS). Platform access tokens are encrypted at rest, passwords
          are stored only as hashes, and each workspace can only see its own data.
        </p>
      </LegalSection>

      <LegalSection title="9. Children">
        <p>
          The Service is meant for businesses and creators aged 18 or over. We do not knowingly
          collect information from children under 13.
        </p>
      </LegalSection>

      <LegalSection title="10. Changes">
        <p>
          We will post any change to this policy here and update the date above. For a significant
          change, we will also notify account holders by email.
        </p>
      </LegalSection>

      <LegalSection title="11. Contact">
        <p>
          {OPERATOR_NAME} ({PRODUCT_NAME}), {OPERATOR_LOCATION}. Email: {mail}.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

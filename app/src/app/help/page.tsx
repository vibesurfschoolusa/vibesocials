import { LegalPage, LegalSection } from "@/components/legal-page";
import { advertisedPlatforms } from "@/lib/advertisedPlatforms";
import { PLATFORM_GUIDES } from "@/lib/platformGuides";
import { PLATFORM_ORDER, platformLabel } from "@/lib/platforms";
import { PRODUCT_NAME, SUPPORT_EMAIL } from "@/lib/siteInfo";

export const metadata = {
  title: "Connecting your accounts | Vibe Socials",
  description:
    "What each platform needs before you connect it to Vibe Socials, what you will see, and what to do when a connection fails.",
};

export default function HelpPage() {
  // Pinterest stays hidden until this deployment can connect it (lib/advertisedPlatforms.ts).
  const advertised = advertisedPlatforms();
  const platforms = PLATFORM_ORDER.filter((platform) => advertised.includes(platform));

  return (
    <LegalPage
      title="Connecting your accounts"
      showUpdated={false}
      intro={
        <p>
          You connect accounts in Settings, under Connections. Only the workspace owner can connect
          an account. Each workspace holds one account per platform.
        </p>
      }
    >
      {platforms.map((platform) => {
        const guide = PLATFORM_GUIDES[platform];
        return (
          <div key={platform} id={guide.anchor} className="scroll-mt-6">
            <LegalSection title={platformLabel(platform)}>
              <div className="space-y-3">
                {guide.status ? (
                  <p
                    role="note"
                    className="rounded-[var(--radius)] border border-warning/40 bg-warning/10 px-3 py-2 text-foreground"
                  >
                    <span className="font-semibold">Note: </span>
                    {guide.status}
                  </p>
                ) : null}
                <GuideList title="What you need" items={guide.needs} />
                <GuideList title="How to connect" items={guide.steps} ordered />
                {guide.tips.length > 0 ? <GuideList title="Good to know" items={guide.tips} /> : null}
              </div>
            </LegalSection>
          </div>
        );
      })}

      <div id="troubleshooting" className="scroll-mt-6">
        <LegalSection title="When something goes wrong">
          <p className="mb-2">
            If a connection fails, Settings shows a message at the top of the page. It means one of
            these:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <span className="text-foreground">You cancelled on the platform&apos;s screen.</span>{" "}
              Nothing was connected. Click Connect to try again.
            </li>
            <li>
              <span className="text-foreground">
                The connection was started from a different account.
              </span>{" "}
              Sign in to the {PRODUCT_NAME} account you want to connect, then try again.
            </li>
            <li>
              <span className="text-foreground">You are not the workspace owner.</span> Only the
              owner can connect accounts. Ask them to connect it.
            </li>
            <li>
              <span className="text-foreground">
                The LinkedIn account is not a Super admin of any company page.
              </span>{" "}
              Sign in to LinkedIn with an account that is a Super admin of your page, then click
              Connect again.
            </li>
            {advertised.includes("pinterest") ? (
              <li>
                <span className="text-foreground">
                  The Pinterest account has no board we can post to.
                </span>{" "}
                Create a board on Pinterest (not a secret one), then click Connect again.
              </li>
            ) : null}
          </ul>
          <p className="mt-2">
            If it still fails, write to{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-2">
              {SUPPORT_EMAIL}
            </a>{" "}
            and say which platform you were connecting.
          </p>
        </LegalSection>
      </div>

      <LegalSection title="Removing access">
        <p>
          Disconnect in Settings removes the connection from {PRODUCT_NAME}. Each platform also lets
          you remove {PRODUCT_NAME}&apos;s access in its own settings.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

function GuideList({
  title,
  items,
  ordered = false,
}: {
  title: string;
  items: string[];
  ordered?: boolean;
}) {
  const List = ordered ? "ol" : "ul";
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground">{title}</h3>
      <List className={`${ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5`}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </List>
    </div>
  );
}

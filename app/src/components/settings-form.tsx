"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkspaceRole } from "@prisma/client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CharacterCount, refuseOverLimit } from "@/components/ui/character-count";
import { useToast } from "@/components/ui/toast";
import {
  BRAND_VOICE_EXAMPLE_MAX_LENGTH,
  BRAND_VOICE_MAX_EXAMPLES,
  BRAND_VOICE_MAX_LENGTH,
  exampleBoxStatus,
  mergeExampleCaptions,
  type MergeExamplesResult,
} from "@/lib/brandVoice";
import { buildCaptionWithFooter } from "@/lib/captionFooter";
import {
  GOOGLE_BUTTON_LABELS,
  GOOGLE_BUTTON_TYPES,
  defaultGoogleButtonUrl,
  parseGoogleButton,
} from "@/lib/googlePostOptions";
import { trackedWebsiteLink } from "@/lib/trackingTags";
import type { UserSettings } from "@/lib/userSettings";
import { answerLostText } from "@/lib/answerLost";
import { fetchOrNoAnswer, isNoAnswer } from "@/lib/requestNoAnswer";
import { readWorkspaceRefusalText, withWorkspaceId } from "@/lib/workspaceChanged";

/** R28 NN2: the settings may have been saved before the answer was lost. */
export const SETTINGS_MAYBE_SAVED_MESSAGE = answerLostText(
  "your settings may have been saved",
  "Reload this page to see them before you save again.",
);

// Mirrors tiktok-post-settings.tsx's checkbox styling for a consistent look
// across the app's few native checkbox controls.
const BRAND_VOICE_PLACEHOLDER =
  "Friendly and short. We say 'surf fam'. No exclamation marks in a row. Always mention the beach we are on.";

const checkboxClass =
  "h-4 w-4 rounded border-input accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/**
 * The tracking-tags checkbox (brief 20), under the website. A member gets it
 * disabled: it is the owner's setting, but it changes the member's posts too.
 */
function TrackingTagsField({
  checked,
  onChange,
  website,
  disabled,
}: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  website: string;
  disabled?: boolean;
}) {
  const example = website.trim() ? trackedWebsiteLink(website.trim(), "facebook_page") : "";
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.checked)}
          className={checkboxClass}
        />
        <span className="text-sm text-foreground">Add tracking tags to my website link</span>
      </label>
      <p className="text-sm text-muted-foreground">
        Your Google Analytics will then show which platform each visit came from. The link in your
        posts gets longer. Where the longer link would not fit, the plain link is used.
      </p>
      <p className="text-sm text-muted-foreground">
        Applies to posts published from now on, including ones already scheduled.
      </p>
      {checked && example ? (
        <p className="break-all text-sm text-muted-foreground">
          On Facebook the link reads: <span className="text-foreground">{example}</span>
        </p>
      ) : null}
    </div>
  );
}

// The route's COMPANY_WEBSITE_MAX_LENGTH and DEFAULT_HASHTAGS_MAX_LENGTH (settings-form.test.ts ties them).
const COMPANY_WEBSITE_MAX_LENGTH = 2048;
const DEFAULT_HASHTAGS_MAX_LENGTH = 1024;
/** The route's own sentence for a footer field over its limit (validateOptionalString). */
function footerTooLongText(label: string, max: number): string {
  return `${label} can be up to ${max.toLocaleString("en-US")} characters.`;
}

// R43 new-customer L1: no maxLength on these boxes, so a paste is never cut
// mid-tag without a word; the shared count (components/ui/character-count.tsx)
// says when the text is over, counted trimmed as the route counts.

const RECENT_POSTS_FAILED_TEXT = "Could not load your recent posts. Try again.";

/**
 * R32 new-customer L3: the published captions "Use my recent posts" adds, read
 * for the workspace this page was drawn for. A tab left on it after another
 * tab switched gets the switch sentence, never the other client's captions.
 */
export async function readRecentCaptions(
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; captions: Array<string | null | undefined> } | { ok: false; text: string }> {
  try {
    const response = await fetchImpl(withWorkspaceId("/api/posts?status=completed", workspaceId));
    const refusal = await readWorkspaceRefusalText(response);
    if (refusal) return { ok: false, text: refusal };
    if (!response.ok) return { ok: false, text: RECENT_POSTS_FAILED_TEXT };
    const data = (await response.json()) as { jobs?: Array<{ caption?: string | null }> };
    return { ok: true, captions: (data.jobs ?? []).map((job) => job.caption) };
  } catch {
    return { ok: false, text: RECENT_POSTS_FAILED_TEXT };
  }
}

/**
 * R64 pages-a-4 L1: "Use my recent posts" when it adds nothing, worded from the
 * counts: a box over five keeps only the first five, and a workspace with no
 * published posts is told so rather than that its posts are already in the box.
 */
export function recentPostsRefusalText(
  result: Exclude<MergeExamplesResult, { kind: "added" }>,
): string {
  if (result.kind === "full") {
    return result.examples > BRAND_VOICE_MAX_EXAMPLES
      ? `The box already has ${result.examples} examples and only the first ${BRAND_VOICE_MAX_EXAMPLES} are kept. Delete lines to make room.`
      : "You already have five examples. Remove one to add another.";
  }
  if (result.kind === "no-posts") {
    return "This workspace has no published posts yet. Type an example of how you write instead.";
  }
  return "Your recent published posts have no captions that are not already in the box. Type an example instead.";
}

interface SettingsFormProps {
  /**
   * The workspace this page was rendered for. POST /api/settings refuses a
   * save for any other (F3): the active workspace is one cookie every tab shares.
   */
  workspaceId: string;
  settings: UserSettings;
  /**
   * Team Workspaces (Task 7, design §7): the caption footer
   * (companyWebsite/defaultHashtags) is workspace-level and owner-only to
   * change — `POST /api/settings` 403s a member request that touches either
   * field, even alongside a valid `notifyOnPostComplete`. A member still sees
   * the footer (read-only, since it affects their own posts' preview) and
   * keeps their own notification-preference control.
   */
  role: WorkspaceRole;
  /** P1: a line under the brand voice and the new-review toggle where the plan leaves them out. */
  planNotes?: { brandVoice?: string; reviewAlerts?: string; monthlyReport?: string };
}

export function SettingsForm({ workspaceId, settings, role, planNotes = {} }: SettingsFormProps) {
  const router = useRouter();
  const toast = useToast();
  const isOwner = role === "owner";
  const [companyWebsite, setCompanyWebsite] = useState(settings.companyWebsite || "");
  const companyWebsiteRef = useRef<HTMLInputElement>(null);
  const defaultHashtagsRef = useRef<HTMLTextAreaElement>(null);
  const [defaultHashtags, setDefaultHashtags] = useState(settings.defaultHashtags || "");
  const [notifyOnPostComplete, setNotifyOnPostComplete] = useState(
    settings.notifyOnPostComplete,
  );
  const [notifyDailyDigest, setNotifyDailyDigest] = useState(settings.notifyDailyDigest);
  const [notifyNewReviews, setNotifyNewReviews] = useState(settings.notifyNewReviews);
  const [notifyMonthlyReport, setNotifyMonthlyReport] = useState(settings.notifyMonthlyReport);
  const [requireApproval, setRequireApproval] = useState(settings.requireApproval);
  const [trackWebsiteLinks, setTrackWebsiteLinks] = useState(settings.trackWebsiteLinks);
  // 2026-11-10: the default Google button. "" = no button. The link starts as
  // the company website until one is saved.
  const [googleButtonType, setGoogleButtonType] = useState(settings.googleButtonType ?? "");
  const [googleButtonUrl, setGoogleButtonUrl] = useState(
    settings.googleButtonUrl ?? defaultGoogleButtonUrl(settings.companyWebsite),
  );
  // The same check POST /api/settings applies, shown before saving.
  const googleButtonCheck = googleButtonType
    ? parseGoogleButton({ type: googleButtonType, url: googleButtonUrl })
    : null;
  const googleButtonError = googleButtonCheck && !googleButtonCheck.ok ? googleButtonCheck.error : null;
  const [brandVoice, setBrandVoice] = useState(settings.brandVoice ?? "");
  const [brandVoiceExamples, setExamplesState] = useState(settings.brandVoiceExamples ?? "");
  // The box's current text, for "Use my recent posts": it merges after the posts
  // load, so it must see what was typed meanwhile, not the text from the click.
  const examplesRef = useRef(brandVoiceExamples);
  const setBrandVoiceExamples = (text: string) => {
    examplesRef.current = text;
    setExamplesState(text);
  };
  const [isFillingExamples, setIsFillingExamples] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const examplesStatus = exampleBoxStatus(brandVoiceExamples);

  // Adds to the box only (never replaces what was typed); the owner edits and
  // then saves with the rest of the form.
  const fillExamplesFromRecentPosts = async () => {
    const before = mergeExampleCaptions(examplesRef.current, []);
    if (before.kind === "full") {
      toast.error(recentPostsRefusalText(before));
      return;
    }
    setIsFillingExamples(true);
    try {
      const read = await readRecentCaptions(workspaceId);
      if (!read.ok) {
        toast.error(read.text);
        return;
      }
      const result = mergeExampleCaptions(examplesRef.current, read.captions);
      if (result.kind !== "added") {
        toast.error(recentPostsRefusalText(result));
        return;
      }
      setBrandVoiceExamples(result.text);
      toast.success(
        `Added ${result.added} ${result.added === 1 ? "caption" : "captions"} from your recent posts. Edit them if you like, then save.`,
      );
    } finally {
      setIsFillingExamples(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // R45 new-customer L1: as every counted field, text the route would refuse is not sent.
    if (
      isOwner &&
      refuseOverLimit(
        [
          {
            text: companyWebsite,
            max: COMPANY_WEBSITE_MAX_LENGTH,
            sentence: footerTooLongText("Company website", COMPANY_WEBSITE_MAX_LENGTH),
            field: companyWebsiteRef.current,
          },
          {
            text: defaultHashtags,
            max: DEFAULT_HASHTAGS_MAX_LENGTH,
            sentence: footerTooLongText("Default hashtags", DEFAULT_HASHTAGS_MAX_LENGTH),
            field: defaultHashtagsRef.current,
          },
        ],
        (sentence) => toast.error(sentence),
      )
    ) {
      return;
    }
    if (isOwner && googleButtonError) {
      toast.error(googleButtonError);
      return;
    }
    setIsLoading(true);

    try {
      // Presence-based split write (design §4, Task 6's route contract): a
      // member's body must OMIT companyWebsite/defaultHashtags entirely, not
      // just leave them unchanged — POST /api/settings 403s the whole
      // request if a non-owner's body touches either key at all.
      const body = isOwner
        ? {
            companyWebsite: companyWebsite.trim(),
            defaultHashtags: defaultHashtags.trim(),
            // Owner-only too (tracking tags on the website link).
            trackWebsiteLinks,
            // Owner-only, same class as the footer fields — a member's body
            // must omit it entirely or the route 403s the whole request.
            requireApproval,
            // Owner-only too (the default Google button).
            googleButtonType: googleButtonType || null,
            googleButtonUrl: googleButtonUrl.trim(),
            // Owner-only too; POST /api/settings cleans both (lib/brandVoice.ts).
            brandVoice,
            brandVoiceExamples,
            notifyOnPostComplete,
            notifyDailyDigest,
            notifyNewReviews,
            notifyMonthlyReport,
          }
        : { notifyOnPostComplete, notifyDailyDigest, notifyNewReviews, notifyMonthlyReport };

      const response = await fetchOrNoAnswer("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, workspaceId }),
      });

      if (!response.ok) {
        // A 409 says another tab switched workspace; show the route's sentence.
        const refused = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error(refused?.error ?? "Failed to save settings. Please try again.");
        return;
      }

      // Show what the server stored: it cuts over-long text and removes hashtags.
      const saved = (await response.json().catch(() => ({}))) as {
        brandVoice?: string | null;
        brandVoiceExamples?: string | null;
      };
      if ("brandVoice" in saved) {
        setBrandVoice(saved.brandVoice ?? "");
      }
      if ("brandVoiceExamples" in saved) {
        setBrandVoiceExamples(saved.brandVoiceExamples ?? "");
      }

      toast.success("Settings saved successfully!");
      router.refresh();
    } catch (caught) {
      toast.error(isNoAnswer(caught) ? SETTINGS_MAYBE_SAVED_MESSAGE : "Failed to save settings. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const previewCaption = () =>
    buildCaptionWithFooter("Check out this amazing content!", {
      companyWebsite,
      defaultHashtags,
    });

  return (
    <Card className="p-6">
      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        {isOwner ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="companyWebsite">Company website</Label>
              <Input
                ref={companyWebsiteRef}
                id="companyWebsite"
                placeholder="www.example.com"
                value={companyWebsite}
                onChange={(e) => setCompanyWebsite(e.target.value)}
                aria-describedby="companyWebsiteCount"
              />
              <CharacterCount id="companyWebsiteCount" label="Company website" text={companyWebsite} max={COMPANY_WEBSITE_MAX_LENGTH} action="save" />
              <p className="text-sm text-muted-foreground">
                Appended to every caption as: &quot;For more info visit [your website]&quot;.
              </p>
            </div>

            <TrackingTagsField
              checked={trackWebsiteLinks}
              onChange={setTrackWebsiteLinks}
              website={companyWebsite}
            />

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="defaultHashtags">Default hashtags</Label>
              <Textarea
                ref={defaultHashtagsRef}
                id="defaultHashtags"
                placeholder="#YourBrand #YourIndustry #YourLocation"
                value={defaultHashtags}
                onChange={(e) => setDefaultHashtags(e.target.value)}
                rows={3}
                aria-describedby="defaultHashtagsCount"
              />
              <CharacterCount id="defaultHashtagsCount" label="Default hashtags" text={defaultHashtags} max={DEFAULT_HASHTAGS_MAX_LENGTH} action="save" />
              <p className="text-sm text-muted-foreground">
                Added after your website, separated by a blank line.
              </p>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-border bg-muted/50 p-4">
            <div>
              <h3 className="text-sm font-medium text-foreground">Company website</h3>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {companyWebsite || "Not set."}
              </p>
            </div>
            <TrackingTagsField checked={trackWebsiteLinks} website={companyWebsite} disabled />
            <div>
              <h3 className="text-sm font-medium text-foreground">Default hashtags</h3>
              <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">
                {defaultHashtags || "Not set."}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Only the workspace owner can change these. They&apos;re appended to your posts
              automatically.
            </p>
          </div>
        )}

        {/* Live preview of the caption footer — shown to members too, since
            it affects their own posts' preview (design §7), even though they
            can't edit the fields it's built from. */}
        <div className="rounded-[var(--radius)] border border-border bg-muted/50 p-4">
          <h3 className="text-sm font-medium text-foreground">Preview</h3>
          <div className="mt-2 whitespace-pre-wrap border-l-2 border-primary pl-3 text-sm text-muted-foreground">
            {previewCaption()}
          </div>
        </div>

        {/* Brand voice (brief 15): workspace-level, owner-only to change. A
            member sees it read-only, like the footer above. */}
        {isOwner ? (
          <div className="flex flex-col gap-1.5 border-t border-border pt-6">
            <h3 className="text-sm font-medium text-foreground">Brand voice</h3>
            {/* P1 fix round 2: without the feature, the plan's sentence takes this one's place. */}
            {planNotes.brandVoice ? (
              <p className="text-sm text-muted-foreground">{planNotes.brandVoice}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                The AI follows this when it writes or rewrites a caption and when it drafts a reply to a
                Google review.
              </p>
            )}
            <Label htmlFor="brandVoice" className="mt-2">
              How you sound
            </Label>
            <Textarea
              id="brandVoice"
              placeholder={BRAND_VOICE_PLACEHOLDER}
              value={brandVoice}
              maxLength={BRAND_VOICE_MAX_LENGTH}
              onChange={(e) => setBrandVoice(e.target.value)}
              rows={3}
              aria-describedby="brandVoiceCount"
            />
            <p id="brandVoiceCount" className="text-xs text-muted-foreground">
              {brandVoice.length} of {BRAND_VOICE_MAX_LENGTH} characters
            </p>
            <p className="text-sm text-muted-foreground">
              Put hashtags in Default hashtags above. The AI does not write hashtags.
            </p>
            <Label htmlFor="brandVoiceExamples" className="mt-2">
              Example captions, one per line (up to {BRAND_VOICE_MAX_EXAMPLES})
            </Label>
            <Textarea
              id="brandVoiceExamples"
              value={brandVoiceExamples}
              onChange={(e) => setBrandVoiceExamples(e.target.value)}
              rows={5}
              aria-describedby="brandVoiceExamplesCount"
            />
            <p id="brandVoiceExamplesCount" aria-live="polite" className="text-xs text-muted-foreground">
              {examplesStatus.count} of {BRAND_VOICE_MAX_EXAMPLES} examples
              {examplesStatus.willShorten ? (
                <span className="text-destructive">
                  {" "}
                  Lines over {BRAND_VOICE_EXAMPLE_MAX_LENGTH} characters are shortened and only the first
                  five are kept.
                </span>
              ) : null}
            </p>
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={isFillingExamples}
                onClick={fillExamplesFromRecentPosts}
              >
                Use my recent posts
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Adds the captions of your latest published posts to the box, without their hashtags, up
              to {BRAND_VOICE_MAX_EXAMPLES} examples. What you typed stays. Nothing is saved until you
              press Save settings.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-border bg-muted/50 p-4">
            <h3 className="text-sm font-semibold text-foreground">Brand voice</h3>
            <div>
              <h3 className="text-sm font-medium text-foreground">How you sound</h3>
              <p className="mt-0.5 text-sm text-muted-foreground">{brandVoice || "Not set."}</p>
            </div>
            <div>
              <h3 className="text-sm font-medium text-foreground">Example captions</h3>
              <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">
                {brandVoiceExamples || "Not set."}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Only the workspace owner can change these. The AI follows them when it writes captions
              and review replies.
            </p>
          </div>
        )}

        {/* Approval workflow (2026-07-26): owner-only workspace policy. Hidden
            from members entirely — they can't change it, and the route 403s a
            body that even mentions it. */}
        {isOwner ? (
          <div className="flex flex-col gap-1.5 border-t border-border pt-6">
            <h3 className="text-sm font-medium text-foreground">Approvals</h3>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={requireApproval}
                onChange={(e) => setRequireApproval(e.target.checked)}
                className={checkboxClass}
              />
              <span className="text-sm text-foreground">
                Require my approval for members&apos; posts
              </span>
            </label>
            <p className="text-sm text-muted-foreground">
              Posts created by members wait in the Queue for you to approve before publishing.
              Your own posts are unaffected.
            </p>
          </div>
        ) : null}

        {/* 2026-11-10: the default Google button, owner-only workspace setting
            (the route 403s a member's body that mentions it). */}
        {isOwner ? (
          <div className="flex flex-col gap-1.5 border-t border-border pt-6">
            <h3 className="text-sm font-medium text-foreground">Google posts</h3>
            <Label htmlFor="googleButtonType">Add this button to every Google post</Label>
            <Select
              id="googleButtonType"
              value={googleButtonType}
              onChange={(e) => setGoogleButtonType(e.target.value)}
            >
              <option value="">No button</option>
              {GOOGLE_BUTTON_TYPES.map((type) => (
                <option key={type} value={type}>
                  {GOOGLE_BUTTON_LABELS[type]}
                </option>
              ))}
            </Select>
            {googleButtonType && googleButtonType !== "CALL" ? (
              <>
                <Label htmlFor="googleButtonUrl" className="mt-2">
                  Button link
                </Label>
                <Input
                  id="googleButtonUrl"
                  type="url"
                  placeholder="https://"
                  value={googleButtonUrl}
                  aria-invalid={googleButtonError ? true : undefined}
                  onChange={(e) => setGoogleButtonUrl(e.target.value)}
                />
              </>
            ) : null}
            {googleButtonError ? (
              <p role="alert" className="text-sm text-destructive">
                {googleButtonError}
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              Every new Google post starts with this button, and you can change it on each post. Posts
              made without choosing get it too. Offers never have a button.
            </p>
          </div>
        ) : null}

        {/* Roadmap Phase 6 / Team Workspaces Task 7: post-outcome email
            preference. Own-user field, open to any member regardless of
            workspace role — submitted on its own for a member (see `body`
            above), alongside the footer fields for an owner. */}
        <div className="flex flex-col gap-1.5 border-t border-border pt-6">
          <h3 className="text-sm font-medium text-foreground">Notifications</h3>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={notifyOnPostComplete}
              onChange={(e) => setNotifyOnPostComplete(e.target.checked)}
              className={checkboxClass}
            />
            <span className="text-sm text-foreground">Email me when a post finishes</span>
          </label>
          <p className="text-sm text-muted-foreground">
            Get a per-platform summary emailed to you whenever a post (including a
            scheduled post or a retry) finishes publishing.
          </p>
          <label className="mt-3 flex items-center gap-2">
            <input
              type="checkbox"
              checked={notifyDailyDigest}
              onChange={(e) => setNotifyDailyDigest(e.target.checked)}
              className={checkboxClass}
            />
            <span className="text-sm text-foreground">
              Email me a daily summary when a post fails, an account needs reconnecting, or a post
              is waiting for approval
            </span>
          </label>
          <p className="text-sm text-muted-foreground">
            Sent to workspace owners, once a day, only on days when something needs attention.
          </p>
          <label className="mt-3 flex items-center gap-2">
            <input
              type="checkbox"
              checked={notifyNewReviews}
              onChange={(e) => setNotifyNewReviews(e.target.checked)}
              className={checkboxClass}
            />
            <span className="text-sm text-foreground">Email me when a new Google review arrives</span>
          </label>
          <p className="text-sm text-muted-foreground">
            Sent to workspace owners, once a day, on days when the Google listing gets new reviews.
          </p>
          {planNotes.reviewAlerts ? <p className="text-sm text-muted-foreground">{planNotes.reviewAlerts}</p> : null}
          <label className="mt-3 flex items-center gap-2">
            <input
              type="checkbox"
              checked={notifyMonthlyReport}
              onChange={(e) => setNotifyMonthlyReport(e.target.checked)}
              className={checkboxClass}
            />
            <span className="text-sm text-foreground">Email me the monthly report</span>
          </label>
          <p className="text-sm text-muted-foreground">
            Sent to workspace owners in the first days of each month, when something was published the
            month before.
          </p>
          {planNotes.monthlyReport ? <p className="text-sm text-muted-foreground">{planNotes.monthlyReport}</p> : null}
        </div>

        <div>
          <Button type="submit" loading={isLoading} className="w-full sm:w-auto">
            {isLoading ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

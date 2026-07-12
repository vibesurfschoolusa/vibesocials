"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkspaceRole } from "@prisma/client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { buildCaptionWithFooter } from "@/lib/captionFooter";
import type { UserSettings } from "@/lib/userSettings";

// Mirrors tiktok-post-settings.tsx's checkbox styling for a consistent look
// across the app's few native checkbox controls.
const checkboxClass =
  "h-4 w-4 rounded border-input accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

interface SettingsFormProps {
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
}

export function SettingsForm({ settings, role }: SettingsFormProps) {
  const router = useRouter();
  const toast = useToast();
  const isOwner = role === "owner";
  const [companyWebsite, setCompanyWebsite] = useState(settings.companyWebsite || "");
  const [defaultHashtags, setDefaultHashtags] = useState(settings.defaultHashtags || "");
  const [notifyOnPostComplete, setNotifyOnPostComplete] = useState(
    settings.notifyOnPostComplete,
  );
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
            notifyOnPostComplete,
          }
        : { notifyOnPostComplete };

      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error("Failed to update settings");
      }

      toast.success("Settings saved successfully!");
      router.refresh();
    } catch {
      toast.error("Failed to save settings. Please try again.");
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
                id="companyWebsite"
                placeholder="www.example.com"
                value={companyWebsite}
                onChange={(e) => setCompanyWebsite(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Appended to every caption as: &quot;For more info visit [your website]&quot;.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="defaultHashtags">Default hashtags</Label>
              <Textarea
                id="defaultHashtags"
                placeholder="#YourBrand #YourIndustry #YourLocation"
                value={defaultHashtags}
                onChange={(e) => setDefaultHashtags(e.target.value)}
                rows={3}
              />
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

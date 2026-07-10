"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { UserSettings } from "@/lib/userSettings";

// Mirrors tiktok-post-settings.tsx's checkbox styling for a consistent look
// across the app's few native checkbox controls.
const checkboxClass =
  "h-4 w-4 rounded border-input accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

interface SettingsFormProps {
  settings: UserSettings;
}

export function SettingsForm({ settings }: SettingsFormProps) {
  const router = useRouter();
  const toast = useToast();
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
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyWebsite: companyWebsite.trim(),
          defaultHashtags: defaultHashtags.trim(),
          notifyOnPostComplete,
        }),
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

  const previewCaption = () => {
    const sampleCaption = "Check out this amazing content!";
    const footer: string[] = [];

    if (companyWebsite.trim()) {
      footer.push(`For more info visit ${companyWebsite.trim()}`);
    }

    if (defaultHashtags.trim()) {
      footer.push(defaultHashtags.trim());
    }

    if (footer.length === 0) {
      return sampleCaption;
    }

    return `${sampleCaption}\n\n${footer.join("\n")}`;
  };

  return (
    <Card className="p-6">
      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
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
            Added on a new line after your website.
          </p>
        </div>

        {/* Live preview of the caption footer. */}
        <div className="rounded-[var(--radius)] border border-border bg-muted/50 p-4">
          <h3 className="text-sm font-medium text-foreground">Preview</h3>
          <div className="mt-2 whitespace-pre-wrap border-l-2 border-primary pl-3 text-sm text-muted-foreground">
            {previewCaption()}
          </div>
        </div>

        {/* Roadmap Phase 6: post-outcome email preference. Submitted together
            with the fields above — POST /api/settings replaces all of them in
            one request, so this must always ride along with the same submit
            rather than get its own form/button. */}
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

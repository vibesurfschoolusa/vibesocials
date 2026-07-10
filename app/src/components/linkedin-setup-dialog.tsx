"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LinkedInSetupDialog() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const showSetup = searchParams.get("linkedin_setup") === "true";

  const [vanityName, setVanityName] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Closing clears the trigger query param (?linkedin_setup=true) so the dialog
  // stays closed. Blocked while a redirect is in flight.
  const handleClose = () => {
    if (isConnecting) return;
    router.push("/settings");
  };

  const handleConnect = () => {
    if (!vanityName.trim()) {
      setFieldError("Enter your LinkedIn company page URL or vanity name.");
      return;
    }
    setFieldError(null);

    // Extract the vanity name/ID from a full URL if the user pasted one.
    // Handles: https://www.linkedin.com/company/vibe-surf-school-usa/,
    // linkedin.com/company/82188987, a bare vanity name, or a numeric ID.
    let cleanVanityName = vanityName.trim();

    if (cleanVanityName.includes("linkedin.com/company/")) {
      const match = cleanVanityName.match(/linkedin\.com\/company\/([^/?#]+)/);
      if (match) {
        cleanVanityName = match[1];
      }
    }

    // Remove any trailing slashes.
    cleanVanityName = cleanVanityName.replace(/\/$/, "");

    // Only lowercase if it's NOT a numeric ID (preserve case for numeric IDs).
    const isNumericId = /^\d+$/.test(cleanVanityName);
    if (!isNumericId) {
      cleanVanityName = cleanVanityName.toLowerCase();
      // Replace spaces with hyphens for vanity names.
      cleanVanityName = cleanVanityName.replace(/\s+/g, "-");
    }

    setIsConnecting(true);

    // Redirect to LinkedIn OAuth start with the vanity name/ID as a query param.
    window.location.href = `/api/auth/linkedin/start?vanity_name=${encodeURIComponent(cleanVanityName)}`;
  };

  return (
    <Dialog
      open={showSetup}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogHeader>
        <DialogTitle>LinkedIn company page setup</DialogTitle>
        <DialogDescription>
          We need your LinkedIn company page URL to complete the connection.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-5">
        <Alert variant="info" title="Company pages only">
          This app posts to LinkedIn company pages, not personal profiles. You must be an
          administrator of the page.
        </Alert>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vanity-name">LinkedIn company page URL</Label>
          <Input
            id="vanity-name"
            value={vanityName}
            onChange={(e) => {
              setVanityName(e.target.value);
              if (fieldError) setFieldError(null);
            }}
            placeholder="e.g., https://www.linkedin.com/company/vibe-surf-school-usa"
            disabled={isConnecting}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? "vanity-name-error" : "vanity-name-hint"}
          />
          {fieldError ? (
            <span id="vanity-name-error" className="text-xs text-destructive">
              {fieldError}
            </span>
          ) : (
            <span id="vanity-name-hint" className="text-xs text-muted-foreground">
              You can paste the full URL (with name or number), e.g.
              https://www.linkedin.com/company/82188987
            </span>
          )}
        </div>

        <div className="rounded-[var(--radius)] border border-border bg-muted/50 p-4">
          <h3 className="text-sm font-semibold text-foreground">
            How to find your company page URL
          </h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Go to LinkedIn and visit your company page.</li>
            <li>Copy the URL from your browser&apos;s address bar.</li>
            <li>Paste it here (e.g. linkedin.com/company/your-company-name).</li>
          </ol>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={handleClose} disabled={isConnecting}>
          Cancel
        </Button>
        <Button onClick={handleConnect} loading={isConnecting}>
          {isConnecting ? "Connecting…" : "Continue to LinkedIn"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

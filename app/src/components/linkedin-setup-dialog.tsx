"use client";

import { useRef, useState, useSyncExternalStore } from "react";
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
import { ExternalLink } from "@/components/external-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LINKEDIN_SIGN_OUT_URL } from "@/lib/linkedinAccount";
import { SUPPORT_EMAIL } from "@/lib/siteInfo";
import { withWorkspaceId } from "@/lib/workspaceChanged";
import { useResetOnReturnFromCache } from "@/components/returnFromCache";

const noSubscription = () => () => {};

/** The callback's answer when the page address from this dialog found nothing. */
const NOT_FOUND = "not_found";

export const LINKEDIN_PAGE_NOT_FOUND = `LinkedIn didn't find that page. Check the page's URL (it looks like linkedin.com/company/your-page) and try again. If it still isn't found, write to us at ${SUPPORT_EMAIL}.`;

// The address typed before leaving for LinkedIn, so a not-found return can
// show what was tried. Only a convenience: blocked storage leaves the field empty.
const ADDRESS_KEY = "linkedin-setup-address";

function keptAddress(): string {
  try {
    return window.sessionStorage.getItem(ADDRESS_KEY) ?? "";
  } catch {
    return "";
  }
}

function keepAddress(address: string): void {
  try {
    window.sessionStorage.setItem(ADDRESS_KEY, address);
  } catch {
    // Not kept; the field starts empty if LinkedIn doesn't find the page.
  }
}

/** `workspaceId`: the workspace this page was rendered for; the start route refuses any other (F3). */
export function LinkedInSetupDialog({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Opens only after hydration, as PendingConnectionDialog does: the server
  // sends no dialog HTML, so an open first render would be React #418.
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  const setup = searchParams.get("linkedin_setup");
  const notFound = setup === NOT_FOUND;
  const showSetup = hydrated && (setup === "true" || notFound);

  const [vanityName, setVanityName] = useState(() => (notFound ? keptAddress() : ""));
  const [isConnecting, setIsConnecting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Continue leaves for LinkedIn; Back may bring this page back from the cache.
  useResetOnReturnFromCache(setIsConnecting, false);

  // Closing clears the trigger query param (?linkedin_setup=) so the dialog
  // stays closed. Blocked while a redirect is in flight.
  const handleClose = () => {
    if (isConnecting) return;
    router.push("/settings");
  };

  const handleConnect = () => {
    if (!vanityName.trim()) {
      // R31 pages L4: read out, with the person taken to the field to fill.
      setFieldError("Enter your LinkedIn company page URL or vanity name.");
      inputRef.current?.focus();
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

    keepAddress(vanityName.trim());
    setIsConnecting(true);

    // Redirect to LinkedIn OAuth start with the vanity name/ID as a query param.
    window.location.href = withWorkspaceId(
      `/api/auth/linkedin/start?vanity_name=${encodeURIComponent(cleanVanityName)}`,
      workspaceId,
    );
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
        {notFound && <Alert variant="danger">{LINKEDIN_PAGE_NOT_FOUND}</Alert>}
        <Alert variant="info" title="Company pages only">
          This app posts to LinkedIn company pages, not personal profiles. The LinkedIn account
          signed in to this browser is the one being connected, and it must be an administrator
          of the page. Wrong account?{" "}
          <ExternalLink href={LINKEDIN_SIGN_OUT_URL} className="font-medium underline underline-offset-2">
            Sign out of LinkedIn
          </ExternalLink>
          , then close this and try again from the LinkedIn card.
        </Alert>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vanity-name">LinkedIn company page URL</Label>
          <Input
            ref={inputRef}
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
            <span id="vanity-name-error" role="alert" className="text-xs text-destructive">
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

"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Chrome's install event; not in the DOM typings. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

/**
 * State for the account menu's "Install app" entry. Lives in the always-mounted
 * menu (not its popover), because `beforeinstallprompt` fires once, early, and
 * the instructions dialog must outlive the popover closing.
 */
export function useInstallApp() {
  // Already running from the home screen: nothing to install. Read once on the
  // client; the entry only renders after a click, so the server value is unused.
  const [installed] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches,
  );
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [instructionsOpen, setInstructionsOpen] = useState(false);

  useEffect(() => {
    function onBeforeInstallPrompt(event: Event) {
      // Keep the browser's own mini-bar from showing; the menu entry asks instead.
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  function install() {
    if (promptEvent) {
      // A prompt can be shown only once; the browser fires a new event if it
      // is still installable afterwards.
      setPromptEvent(null);
      promptEvent.prompt().catch(() => setInstructionsOpen(true));
      return;
    }
    setInstructionsOpen(true);
  }

  return { available: !installed, install, instructionsOpen, setInstructionsOpen };
}

/** For browsers with no install prompt to trigger (Safari, Firefox, Chrome before it offers one). */
export function InstallInstructionsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="max-w-md">
      <DialogClose />
      <DialogHeader>
        <DialogTitle>Install Vibe Socials on your phone</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-2">
        <p>On iPhone: tap Share in Safari, then &ldquo;Add to Home Screen&rdquo;.</p>
        <p>On Android: open the browser menu and choose &ldquo;Install app&rdquo;.</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

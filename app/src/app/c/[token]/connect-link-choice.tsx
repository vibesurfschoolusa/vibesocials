"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

/**
 * The visitor chooses which of several accounts to connect (2026-11-11), from
 * /api/connect-link/[token]/pending/[id]. One button per account and Cancel.
 * Either way the page reloads with its outcome, so the sentence at the top
 * and the platform rows say what happened.
 */

type Candidate = { id: string; name: string; detail?: string };

type State =
  | { status: "loading" }
  | { status: "ready"; platform: string; candidates: Candidate[] }
  | { status: "gone"; message: string };

export function ConnectLinkChoice({ token, pendingId }: { token: string; pendingId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/connect-link/${encodeURIComponent(token)}/pending/${encodeURIComponent(pendingId)}`;
  const page = `/c/${encodeURIComponent(token)}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(base, { cache: "no-store" });
        const data = (await response.json().catch(() => null)) as
          | { platform?: string; candidates?: Candidate[]; error?: string }
          | null;
        if (cancelled) return;
        if (!response.ok || !data?.platform || !data.candidates) {
          setState({ status: "gone", message: data?.error ?? "This choice expired. Connect again." });
          return;
        }
        setState({ status: "ready", platform: data.platform, candidates: data.candidates });
      } catch {
        if (!cancelled) setState({ status: "gone", message: "Couldn't load the accounts. Reload this page." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base]);

  async function choose(candidateId: string) {
    setBusy(candidateId);
    setError(null);
    try {
      const response = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; platform?: string; error?: string } | null;
      if (response.ok && data?.ok && data.platform) {
        router.push(`${page}?success=${encodeURIComponent(`${data.platform}_connected`)}`);
        return;
      }
      setError(data?.error ?? "Couldn't connect that account. Try again.");
    } catch {
      setError("Couldn't connect that account. Try again.");
    }
    setBusy(null);
  }

  async function cancel(platform: string) {
    setBusy("cancel");
    try {
      await fetch(base, { method: "DELETE" });
    } catch {
      // The choice expires by itself in 15 minutes.
    }
    router.push(`${page}?error=${encodeURIComponent(`${platform}_cancelled`)}`);
  }

  if (state.status === "loading") return <p className="text-sm text-muted-foreground">Loading the accounts…</p>;
  if (state.status === "gone") return <p className="text-sm">{state.message}</p>;

  return (
    <section className="rounded-[var(--radius)] border p-4">
      <h2 className="text-base font-semibold">Choose the account to connect</h2>
      <ul className="mt-3 space-y-2">
        {state.candidates.map((candidate) => (
          <li key={candidate.id} className="flex items-center justify-between gap-3">
            <span className="min-w-0 break-words">
              {candidate.name}
              {candidate.detail ? (
                <span className="block text-sm text-muted-foreground">{candidate.detail}</span>
              ) : null}
            </span>
            <Button
              type="button"
              size="sm"
              loading={busy === candidate.id}
              disabled={busy !== null}
              onClick={() => choose(candidate.id)}
            >
              Connect
            </Button>
          </li>
        ))}
      </ul>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      <Button type="button" variant="outline" size="sm" className="mt-4" disabled={busy !== null} onClick={() => cancel(state.platform)}>
        Cancel
      </Button>
    </section>
  );
}

import Link from "next/link";
import type { Metadata } from "next";

import { BrandMark } from "@/components/brand-mark";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = {
  title: "Reset your password",
};

export default function ResetPasswordPage() {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-4 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-primary/5 via-background to-background"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 -z-10 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
      />

      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Link
            href="/"
            aria-label="Vibe Socials home"
            className="rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <BrandMark className="h-14 w-14 rounded-2xl shadow-lg" />
          </Link>
        </div>

        {/* The Card (with its state-dependent header) lives in the client form,
            which reads the token from the URL fragment and swaps between the
            loading / invalid-link / form / success states. */}
        <ResetPasswordForm />
      </div>
    </div>
  );
}

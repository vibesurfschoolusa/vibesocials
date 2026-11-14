import type { Metadata } from "next";

import { billingEnabled, trialDays } from "@/lib/billing";
import { REGISTER_AGREEMENT } from "@/lib/billingTerms";

import { RegisterForm, type RegisterBilling } from "./register-form";

export const metadata: Metadata = {
  title: "Create an account | Vibe Socials",
};

/**
 * A server component (23) only so it can read the billing setting, which the
 * client form cannot; the form is the page as it was. The billing lines go
 * down as strings: the client form imports nothing from billingTerms.ts (fix
 * round 1). F7 (R1 L5): what the person agrees to shows with billing off too;
 * only the trial line depends on billing.
 */
export default function RegisterPage() {
  const billing: RegisterBilling = {
    trialLine: billingEnabled() ? `${trialDays()}-day free trial. No card needed.` : null,
    agreement: { ...REGISTER_AGREEMENT },
  };
  return <RegisterForm billing={billing} />;
}

import { billingEnabled, trialDays } from "@/lib/billing";
import { REGISTER_AGREEMENT } from "@/lib/billingTerms";

import { RegisterForm, type RegisterBilling } from "./register-form";

/**
 * A server component (23) only so it can read the billing setting, which the
 * client form cannot; the form is the page as it was. With billing off it
 * renders exactly what it did before. The billing lines go down as strings:
 * the client form imports nothing from billingTerms.ts (fix round 1).
 */
export default function RegisterPage() {
  const billing: RegisterBilling = billingEnabled()
    ? { trialLine: `${trialDays()}-day free trial. No card needed.`, agreement: { ...REGISTER_AGREEMENT } }
    : null;
  return <RegisterForm billing={billing} />;
}

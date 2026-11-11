import { billingEnabled, trialDays } from "@/lib/billing";

import { RegisterForm } from "./register-form";

/**
 * A server component (23) only so it can read the billing setting, which the
 * client form cannot; the form is the page as it was. With billing off it
 * renders exactly what it did before.
 */
export default function RegisterPage() {
  return <RegisterForm billing={billingEnabled() ? { trialDays: trialDays() } : null} />;
}

export type SettingsSection = { id: string; label: string };

/**
 * The section links, one per section the page renders, in page order. The ids
 * are the headings' anchors, which other pages link to (#connections, #plan).
 */
export function settingsSections({ planShown }: { planShown: boolean }): SettingsSection[] {
  return [
    { id: "post-defaults", label: "Posts and emails" },
    { id: "posting-times", label: "Posting times" },
    { id: "connections", label: "Connections" },
    { id: "team", label: "Team" },
    ...(planShown ? [{ id: "plan", label: "Plan" }] : []),
    { id: "usage", label: "Usage" },
    { id: "account", label: "Account" },
  ];
}

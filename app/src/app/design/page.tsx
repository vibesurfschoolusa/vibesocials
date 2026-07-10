"use client";

import { useEffect, useState } from "react";
import {
  Inbox,
  Moon,
  Rocket,
  Sun,
  Trash2,
} from "lucide-react";

import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  Select,
  Skeleton,
  Spinner,
  Textarea,
  ToastProvider,
  useToast,
  type BadgeVariant,
  type ButtonSize,
  type ButtonVariant,
} from "@/components/ui";

const BUTTON_VARIANTS: ButtonVariant[] = [
  "primary",
  "secondary",
  "outline",
  "ghost",
  "destructive",
  "link",
];
const BUTTON_SIZES: ButtonSize[] = ["sm", "md", "lg"];
const BADGE_VARIANTS: BadgeVariant[] = [
  "default",
  "secondary",
  "outline",
  "success",
  "warning",
  "danger",
  "neutral",
];

interface Swatch {
  name: string;
  className: string;
  border?: boolean;
}

const SURFACE_SWATCHES: Swatch[] = [
  { name: "background", className: "bg-background", border: true },
  { name: "card / surface", className: "bg-card", border: true },
  { name: "muted", className: "bg-muted" },
  { name: "secondary", className: "bg-secondary" },
  { name: "accent", className: "bg-accent" },
  { name: "border", className: "bg-border" },
  { name: "input", className: "bg-input" },
];

const ACCENT_SWATCHES: Swatch[] = [
  { name: "primary", className: "bg-primary" },
  { name: "ring", className: "bg-ring" },
  { name: "success", className: "bg-success" },
  { name: "warning", className: "bg-warning" },
  { name: "destructive", className: "bg-destructive" },
  { name: "foreground", className: "bg-foreground" },
  { name: "muted-fg", className: "bg-muted-foreground" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function SwatchGrid({ swatches }: { swatches: Swatch[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      {swatches.map((s) => (
        <div key={s.name} className="flex flex-col gap-1.5">
          <div
            className={`h-14 w-full rounded-[var(--radius)] ${s.className} ${
              s.border ? "border border-border" : ""
            }`}
          />
          <span className="text-xs text-muted-foreground">{s.name}</span>
        </div>
      ))}
    </div>
  );
}

function ToastDemo() {
  const toast = useToast();
  return (
    <div className="flex flex-wrap gap-3">
      <Button variant="outline" onClick={() => toast.success("Post published to 6 platforms.")}>
        Success toast
      </Button>
      <Button variant="outline" onClick={() => toast.error("TikTok upload failed.")}>
        Error toast
      </Button>
      <Button variant="outline" onClick={() => toast.info("Draft saved.")}>
        Info toast
      </Button>
    </div>
  );
}

export default function DesignPreviewPage() {
  const [dark, setDark] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light");
    root.classList.toggle("dark", dark);
    return () => root.classList.remove("dark");
  }, [dark]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-5xl flex-col gap-12 px-4 py-10 sm:px-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius)] bg-primary text-primary-foreground">
                <Rocket className="h-4 w-4" />
              </span>
              <h1 className="text-2xl font-bold tracking-tight">Vibe Socials design system</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              Phase A preview &mdash; tokens and primitives. Dev-facing; safe to keep or remove.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => setDark((d) => !d)}
            aria-pressed={dark}
          >
            {dark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            {dark ? "Dark" : "Light"}
          </Button>
        </header>

        <Section title="Color tokens">
          <SwatchGrid swatches={SURFACE_SWATCHES} />
          <SwatchGrid swatches={ACCENT_SWATCHES} />
        </Section>

        <Section title="Buttons">
          <div className="flex flex-col gap-4">
            {BUTTON_SIZES.map((size) => (
              <div key={size} className="flex flex-wrap items-center gap-3">
                <span className="w-8 text-xs uppercase text-muted-foreground">{size}</span>
                {BUTTON_VARIANTS.map((variant) => (
                  <Button key={variant} variant={variant} size={size}>
                    {variant}
                  </Button>
                ))}
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <span className="w-8 text-xs uppercase text-muted-foreground">more</span>
              <Button loading>Loading</Button>
              <Button disabled>Disabled</Button>
              <Button size="icon" aria-label="Delete">
                <Trash2 className="h-4 w-4" />
              </Button>
              <ButtonLink href="#buttons" variant="secondary">
                ButtonLink anchor
              </ButtonLink>
            </div>
          </div>
        </Section>

        <Section title="Badges">
          <div className="flex flex-wrap items-center gap-2">
            {BADGE_VARIANTS.map((variant) => (
              <Badge key={variant} variant={variant}>
                {variant}
              </Badge>
            ))}
          </div>
        </Section>

        <Section title="Alerts">
          <div className="flex flex-col gap-3">
            <Alert variant="info" title="Heads up">
              Connect a platform to start cross-posting.
            </Alert>
            <Alert variant="success" title="Published">
              Your post reached all connected platforms.
            </Alert>
            <Alert variant="warning" title="Token expiring">
              Your YouTube connection expires in 3 days.
            </Alert>
            <Alert variant="danger" title="Post failed">
              We could not reach the TikTok API. Try again shortly.
            </Alert>
          </div>
        </Section>

        <Section title="Form fields">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="demo-email">Email</Label>
              <Input id="demo-email" type="email" placeholder="you@example.com" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="demo-platform">Platform</Label>
              <Select id="demo-platform" defaultValue="tiktok">
                <option value="tiktok">TikTok</option>
                <option value="youtube">YouTube</option>
                <option value="instagram">Instagram</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="demo-invalid">Invalid field</Label>
              <Input id="demo-invalid" aria-invalid defaultValue="not-an-email" />
              <span className="text-xs text-destructive">Enter a valid email.</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="demo-caption">Caption</Label>
              <Textarea id="demo-caption" placeholder="Write a caption&hellip;" />
            </div>
          </div>
        </Section>

        <Section title="Cards">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Connection health</CardTitle>
                <CardDescription>4 of 6 platforms connected.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Badge variant="success">TikTok</Badge>
                <Badge variant="success">YouTube</Badge>
                <Badge variant="warning">Instagram</Badge>
                <Badge variant="neutral">LinkedIn</Badge>
              </CardContent>
              <CardFooter>
                <Button size="sm">Manage</Button>
                <Button size="sm" variant="ghost">
                  Dismiss
                </Button>
              </CardFooter>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Loading state</CardTitle>
                <CardDescription>Skeleton placeholders.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-24 w-full" />
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section title="Spinner">
          <div className="flex items-center gap-6">
            <Spinner size="sm" />
            <Spinner size="md" />
            <Spinner size="lg" />
            <span className="text-sm text-muted-foreground">
              Also used inside loading buttons.
            </span>
          </div>
        </Section>

        <Section title="Empty state">
          <EmptyState
            icon={<Inbox />}
            title="No posts yet"
            description="Create your first post to see per-platform results here."
            action={<Button>Create post</Button>}
          />
        </Section>

        <Section title="Dialogs and toasts">
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => setDialogOpen(true)}>
              Open dialog
            </Button>
            <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
              Open confirm
            </Button>
          </div>
          <ToastProvider>
            <ToastDemo />
          </ToastProvider>
        </Section>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogClose />
          <DialogHeader>
            <DialogTitle>Set up LinkedIn</DialogTitle>
            <DialogDescription>
              Accessible modal: focus trap, Esc to close, backdrop click, scroll lock.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="demo-org">Organization ID</Label>
              <Input id="demo-org" placeholder="urn:li:organization:123" />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setDialogOpen(false)}>Save</Button>
          </DialogFooter>
        </Dialog>

        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          destructive
          title="Disconnect TikTok?"
          description="This removes the stored token. You can reconnect at any time."
          confirmText="Disconnect"
          onConfirm={() => {
            /* demo: no-op */
          }}
        />
      </div>
    </div>
  );
}

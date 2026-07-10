/**
 * Vibe Socials design-system primitives. Import from `@/components/ui`.
 *
 * All primitives are token-driven (light + dark for free), typed, and accept a
 * `className` override merged via `cn()`.
 */
export { Alert, type AlertProps, type AlertVariant } from "@/components/ui/alert";
export { Badge, type BadgeProps, type BadgeVariant } from "@/components/ui/badge";
export {
  Button,
  ButtonLink,
  buttonVariants,
  type ButtonProps,
  type ButtonLinkProps,
  type ButtonSize,
  type ButtonVariant,
  type ButtonVariantOptions,
} from "@/components/ui/button";
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
export {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  type ConfirmDialogProps,
  type DialogProps,
} from "@/components/ui/dialog";
export { EmptyState, type EmptyStateProps } from "@/components/ui/empty-state";
export { Input, fieldBaseClasses, type InputProps } from "@/components/ui/input";
export { Label } from "@/components/ui/label";
export { Select, type SelectProps } from "@/components/ui/select";
export { Skeleton } from "@/components/ui/skeleton";
export { Spinner, type SpinnerProps } from "@/components/ui/spinner";
export { Textarea, type TextareaProps } from "@/components/ui/textarea";
export { ToastProvider, useToast } from "@/components/ui/toast";

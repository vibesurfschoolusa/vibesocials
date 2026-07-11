"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

type ToastVariant = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const AUTO_DISMISS_MS: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  error: 8000, // errors carry actionable info — give them longer
};

/**
 * Access the toast API. Must be called inside a {@link ToastProvider}.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

/**
 * Self-contained, dependency-free toast provider. Scopes toast state to its
 * subtree and renders the notification stack itself, so consumers only need to
 * wrap their content in <ToastProvider>.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const armDismiss = useCallback(
    (id: number, variant: ToastVariant) => {
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => dismiss(id), AUTO_DISMISS_MS[variant]);
      timers.current.set(id, timer);
    },
    [dismiss]
  );

  const pauseDismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (message: string, variant: ToastVariant) => {
      idRef.current += 1;
      const id = idRef.current;
      setToasts((prev) => [...prev, { id, message, variant }]);
      armDismiss(id, variant);
    },
    [armDismiss]
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      success: (message: string) => push(message, "success"),
      error: (message: string) => push(message, "error"),
      info: (message: string) => push(message, "info"),
    }),
    [push]
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((timer) => clearTimeout(timer));
      map.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} onPause={pauseDismiss} onResume={armDismiss} />
    </ToastContext.Provider>
  );
}

const VARIANT_STYLES: Record<
  ToastVariant,
  { container: string; icon: ReactNode }
> = {
  success: {
    container: "border-success/25 bg-success/10 text-foreground",
    icon: <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-success" />,
  },
  error: {
    container: "border-destructive/25 bg-destructive/10 text-foreground",
    icon: <AlertCircle className="h-5 w-5 flex-shrink-0 text-destructive" />,
  },
  info: {
    container: "border-primary/25 bg-primary/10 text-foreground",
    icon: <Info className="h-5 w-5 flex-shrink-0 text-primary" />,
  },
};

function Toaster({
  toasts,
  onDismiss,
  onPause,
  onResume,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
  onPause: (id: number) => void;
  onResume: (id: number, variant: ToastVariant) => void;
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 left-4 right-4 sm:left-auto sm:w-full sm:max-w-sm z-[60] flex flex-col gap-2"
    >
      {toasts.map((toast) => {
        const styles = VARIANT_STYLES[toast.variant];
        return (
          <div
            key={toast.id}
            role={toast.variant === "error" ? "alert" : "status"}
            onMouseEnter={() => onPause(toast.id)}
            onMouseLeave={() => onResume(toast.id, toast.variant)}
            className={`pointer-events-auto flex items-start gap-3 rounded-lg border px-4 py-3 shadow-lg ${styles.container}`}
          >
            {styles.icon}
            <p className="flex-1 text-sm font-medium">{toast.message}</p>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss notification"
              className="flex-shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-opacity"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

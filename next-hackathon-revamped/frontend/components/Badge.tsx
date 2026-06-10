import { cn } from "@/lib/utils";

type BadgeVariant = "default" | "success" | "warning" | "danger" | "info" | "muted";

const variants: Record<BadgeVariant, string> = {
  default: "bg-accent/15 text-accent-bright border-accent/25",
  success: "bg-success/15 text-success border-success/25",
  warning: "bg-warning/15 text-warning border-warning/25",
  danger:  "bg-danger/15 text-danger border-danger/25",
  info:    "bg-info/15 text-info border-info/25",
  muted:   "bg-white/5 text-text-muted border-white/6",
};

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
  dot?: boolean;
}

export function Badge({ children, variant = "default", className, dot }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-[510]",
        variants[variant],
        className
      )}
    >
      {dot && (
        <span
          className={cn("h-1.5 w-1.5 rounded-full", {
            "bg-accent-bright":  variant === "default",
            "bg-success animate-pulse-dot": variant === "success",
            "bg-warning":        variant === "warning",
            "bg-danger":         variant === "danger",
            "bg-info":           variant === "info",
            "bg-text-muted":     variant === "muted",
          })}
        />
      )}
      {children}
    </span>
  );
}

export function statusBadge(status: string) {
  const map: Record<string, BadgeVariant> = {
    done:     "success",
    running:  "info",
    pending:  "warning",
    failed:   "danger",
    skipped:  "muted",
    started:  "info",
  };
  return <Badge variant={map[status] ?? "muted"} dot>{status}</Badge>;
}

const verdictLabels: Record<string, { label: string; variant: BadgeVariant }> = {
  exact_match:     { label: "Exact Match",        variant: "danger" },
  clone_suspect:   { label: "Clone Suspect",      variant: "danger" },
  high_similarity: { label: "High Similarity",    variant: "warning" },
  same_family:     { label: "Same Family",        variant: "info" },
  unknown:         { label: "Unknown / Original", variant: "success" },
};

export function verdictBadge(verdict: string) {
  const meta = verdictLabels[verdict] ?? { label: verdict, variant: "muted" as BadgeVariant };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

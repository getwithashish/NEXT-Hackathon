import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface StatCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  delta?: string;
  deltaUp?: boolean;
  accent?: boolean;
  className?: string;
}

export function StatCard({ label, value, icon: Icon, delta, deltaUp, accent, className }: StatCardProps) {
  return (
    <div
      className={cn(
        "surface-card hairline-top group/card overflow-hidden p-4 sm:p-5 transition-all duration-200",
        accent && "shadow-glow-accent",
        className
      )}
    >
      {/* Accent radial glow in the corner for emphasized cards */}
      {accent && (
        <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-accent/20 blur-2xl" />
      )}

      <div className="relative flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-[560] uppercase tracking-[0.08em] text-text-subtle">{label}</p>
          <p
            className="mt-2.5 text-[28px] leading-none font-[640] text-text-primary tabular-nums"
            style={{ letterSpacing: "-0.5px" }}
          >
            {value}
          </p>
          {delta && (
            <p className={cn("mt-1.5 text-[12px] font-[510]", deltaUp ? "text-success" : "text-danger")}>
              {deltaUp ? "↑" : "↓"} {delta}
            </p>
          )}
        </div>
        <div className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform duration-200 group-hover/card:scale-105",
          accent
            ? "bg-accent-gradient shadow-glow-accent-sm"
            : "border border-white/[0.08] bg-white/[0.04]"
        )}>
          <Icon className={cn("h-4 w-4", accent ? "text-white" : "text-text-muted")} />
        </div>
      </div>
    </div>
  );
}

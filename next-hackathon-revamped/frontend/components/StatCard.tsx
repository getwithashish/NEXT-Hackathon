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
        "relative overflow-hidden rounded-md border border-white/6 bg-white/[0.02] p-4 transition-colors hover:bg-white/[0.04]",
        className
      )}
    >
      {/* Subtle accent glow on top */}
      {accent && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent" />
      )}

      <div className="flex items-start justify-between">
        <div>
          <p className="text-[12px] font-[510] uppercase tracking-wider text-text-subtle">{label}</p>
          <p
            className="mt-2 text-2xl font-[590] text-text-primary"
            style={{ letterSpacing: "-0.288px" }}
          >
            {value}
          </p>
          {delta && (
            <p className={cn("mt-1 text-[12px]", deltaUp ? "text-success" : "text-danger")}>
              {deltaUp ? "↑" : "↓"} {delta}
            </p>
          )}
        </div>
        <div className={cn(
          "flex h-8 w-8 items-center justify-center rounded-md",
          accent ? "bg-accent/10 border border-accent/20" : "bg-white/5 border border-white/6"
        )}>
          <Icon className={cn("h-4 w-4", accent ? "text-accent-bright" : "text-text-muted")} />
        </div>
      </div>
    </div>
  );
}

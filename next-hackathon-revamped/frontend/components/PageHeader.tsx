import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, icon: Icon, action, className }: PageHeaderProps) {
  return (
    <div className={cn("mb-6 sm:mb-8", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {Icon && (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/10 border border-accent/20">
              <Icon className="h-4 w-4 text-accent-bright" />
            </div>
          )}
          <div className="min-w-0">
            <h1
              className="text-xl sm:text-2xl font-[590] tracking-tight text-text-primary truncate"
              style={{ letterSpacing: "-0.288px" }}
            >
              {title}
            </h1>
            {subtitle && (
              <p className="mt-0.5 text-[12px] sm:text-[13px] text-text-muted leading-snug">{subtitle}</p>
            )}
          </div>
        </div>
        {action && <div className="shrink-0 mt-0.5">{action}</div>}
      </div>
    </div>
  );
}

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
    <div className={cn("flex items-start justify-between mb-8", className)}>
      <div className="flex items-center gap-3">
        {Icon && (
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/10 border border-accent/20">
            <Icon className="h-4 w-4 text-accent-bright" />
          </div>
        )}
        <div>
          <h1 className="text-2xl font-[590] tracking-tight text-text-primary" style={{ letterSpacing: "-0.288px" }}>
            {title}
          </h1>
          {subtitle && (
            <p className="mt-0.5 text-[13px] text-text-muted">{subtitle}</p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

import { cn } from "@/lib/utils";

interface SimilarityMeterProps {
  value: number; // 0-1
  showLabel?: boolean;
  className?: string;
}

function getColor(v: number) {
  if (v >= 0.90) return { bar: "bg-danger",   text: "text-danger",   label: "Clone Suspect" };
  if (v >= 0.75) return { bar: "bg-warning",  text: "text-warning",  label: "High Similarity" };
  if (v >= 0.50) return { bar: "bg-info",     text: "text-info",     label: "Moderate" };
  return               { bar: "bg-success",   text: "text-success",  label: "Distinct" };
}

export function SimilarityMeter({ value, showLabel = true, className }: SimilarityMeterProps) {
  const pct = Math.round(value * 100);
  const { bar, text, label } = getColor(value);
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-1.5 w-20 rounded-full bg-white/10 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", bar)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={cn("font-mono text-[12px] font-[500] tabular-nums", text)}>
        {pct}%
      </span>
      {showLabel && (
        <span className="text-[11px] text-text-subtle">{label}</span>
      )}
    </div>
  );
}

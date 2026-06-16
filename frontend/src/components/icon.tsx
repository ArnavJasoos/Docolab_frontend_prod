import { cn } from "@/lib/utils";

export function Icon({
  name,
  fill = false,
  size,
  className,
  style,
}: {
  name: string;
  fill?: boolean;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={cn("material-symbols-outlined", fill && "fill", className)}
      style={{ ...(size ? { fontSize: `${size}px` } : {}), ...style }}
    >
      {name}
    </span>
  );
}

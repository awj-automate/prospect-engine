import type { IcpFit } from "@/lib/types";

export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function fmtRelative(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function scoreColor(score: number | null | undefined): string {
  const s = score ?? 0;
  if (s >= 70) return "text-emerald-600 dark:text-emerald-400";
  if (s >= 40) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

export function icpFitVariant(fit: IcpFit | string | null | undefined): "success" | "warning" | "muted" {
  if (fit === "fit") return "success";
  if (fit === "maybe") return "warning";
  return "muted";
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return Math.round(n).toLocaleString();
}

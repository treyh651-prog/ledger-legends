// All money is stored as integer cents. No float math anywhere in the data layer.

export function money(cents: number, opts: { sign?: boolean; dash?: boolean } = {}): string {
  if (opts.dash && cents === 0) return "0.00";
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const s = whole.toLocaleString("en-US") + "." + String(frac).padStart(2, "0");
  if (neg) return "(" + s + ")";
  return opts.sign ? "+" + s : s;
}

export function usd(cents: number): string {
  const neg = cents < 0;
  return (neg ? "-$" : "$") + money(Math.abs(cents));
}

export function signedUsd(cents: number): string {
  if (cents === 0) return "$0.00";
  return (cents > 0 ? "+$" : "-$") + money(Math.abs(cents));
}

export function pct(numerator: number, denominator = 100, digits = 1): string {
  if (!denominator) return "n/a";
  return ((numerator / denominator) * 100).toFixed(digits) + "%";
}

export function parseAmountToCents(input: string): number {
  const cleaned = input.replace(/[^0-9.-]/g, "");
  if (!cleaned) return 0;
  const negative = cleaned.trim().startsWith("-");
  const [w, f = ""] = cleaned.replace("-", "").split(".");
  const whole = parseInt(w || "0", 10) || 0;
  const frac = parseInt((f + "00").slice(0, 2), 10) || 0;
  const total = whole * 100 + frac;
  return negative ? -total : total;
}

export function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${d}, ${y}`;
}

export function fmtShortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${d}`;
}

export function fmtPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${months[m - 1]} ${y}`;
}

export function fmtPeriodShort(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${String(y).slice(2)}`;
}

export function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso + "T00:00:00Z");
  const b = Date.parse(bIso + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

export function addDays(iso: string, days: number): string {
  const t = Date.parse(iso + "T00:00:00Z") + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let h = d.getHours();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${h}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
}

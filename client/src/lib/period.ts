/** The header keeps periods as YYYY-MM. The API names a period by its first day. */
export function periodToDay(period: string): string {
  return /^\d{4}-\d{2}$/.test(period) ? `${period}-01` : period;
}
export function dayToPeriod(day: string): string {
  return day.slice(0, 7);
}
export function isUuid(v: string | null | undefined): v is string {
  return !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

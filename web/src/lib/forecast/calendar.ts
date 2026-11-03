// Days are whole numbers since 1970-01-01. The server already cut them in the company's time zone,
// so nothing here depends on the browser's time zone.
export const toDay = (iso: string): number => Math.round(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / 864e5)
export const toIso = (day: number): string => new Date(day * 864e5).toISOString().slice(0, 10)
export const weekdayOf = (day: number): number => ((day % 7) + 11) % 7
export function dayOfYear(day: number): number {
  const t = new Date(day * 864e5)
  return Math.floor((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5) + 1
}

export function formatBytes(size: number | null): string {
  if (size === null || size === undefined || isNaN(size)) return "—";
  if (size === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / Math.pow(1024, i);
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  let d = new Date(iso);
  // WorkDrive omits the year on current-year dates ("Aug 19, 4:49 PM").
  // JS Date treats a missing year as 2001.
  if (!/\b\d{4}\b/.test(iso) && (isNaN(d.getTime()) || d.getFullYear() === 2001)) {
    d = new Date(iso.replace(",", `, ${new Date().getFullYear()}`));
    if (!isNaN(d.getTime()) && d.getTime() > Date.now() + 86_400_000) {
      d.setFullYear(d.getFullYear() - 1);
    }
  }
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

export function brandColor(code: string): string {
  const palette = ["#b5541c", "#2e7d5b", "#6d4bc4", "#b03a5b", "#3a7ab0"];
  let hash = 0;
  for (const ch of code) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

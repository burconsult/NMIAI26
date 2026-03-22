function solverTimeZone(): string {
  return process.env.TRIPLETEX_TIMEZONE?.trim() || "Europe/Oslo";
}

function zonedFormatter(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: solverTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function zonedParts(date: Date): { year: number; month: number; day: number } {
  const parts = zonedFormatter().formatToParts(date);
  const get = (type: "year" | "month" | "day"): number => {
    const part = parts.find((item) => item.type === type)?.value;
    return Number(part);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
  };
}

function zonedAnchorDate(date: Date): Date {
  const parts = zonedParts(date);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
}

export function formatIsoDateInZone(date: Date): string {
  const parts = zonedParts(date);
  const year = String(parts.year).padStart(4, "0");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayIsoInZone(): string {
  return formatIsoDateInZone(new Date());
}

export function shiftIsoDateInZone(offsets: { days?: number; years?: number }): string {
  const anchor = zonedAnchorDate(new Date());
  if (offsets.years) anchor.setUTCFullYear(anchor.getUTCFullYear() + offsets.years);
  if (offsets.days) anchor.setUTCDate(anchor.getUTCDate() + offsets.days);
  return formatIsoDateInZone(anchor);
}

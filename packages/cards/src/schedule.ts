/**
 * Cron in words, and when it next fires, for routine cards.
 *
 * Routines are stored as 5-field cron because that is what the scheduler reads,
 * but a card that says `40 8 * * 1-5` asks the person to check the agent's
 * arithmetic. These describe the shapes people ask for and fall back to the raw
 * expression for anything else, rather than guessing.
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatTime(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** "Weekdays at 8:40 AM" for `40 8 * * 1-5`; the expression itself when the shape is unusual. */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron.trim();
  const [min, hr, dom, mon, dow] = parts as [string, string, string, string, string];
  if (mon !== "*") return cron.trim();

  if (/^\*\/\d+$/.test(min) && hr === "*") return `Every ${min.slice(2)} minutes`;
  if (/^\*\/\d+$/.test(hr) && /^\d+$/.test(min)) return `Every ${hr.slice(2)} hours`;
  if (hr === "*" && /^\d+$/.test(min)) {
    return min === "0" ? "Every hour, on the hour" : `Every hour at :${min.padStart(2, "0")}`;
  }
  if (/^\d+$/.test(hr) && /^\d+$/.test(min) && Number(hr) < 24 && Number(min) < 60) {
    const at = `at ${formatTime(Number(hr), Number(min))}`;
    if (dom === "*") {
      if (dow === "*") return `Every day ${at}`;
      if (dow === "1-5") return `Weekdays ${at}`;
      if (dow === "0,6" || dow === "6,0") return `Weekends ${at}`;
      if (/^[0-7]$/.test(dow)) return `Every ${WEEKDAYS[Number(dow) % 7]} ${at}`;
      if (/^[0-7](,[0-7])+$/.test(dow)) {
        const days = dow.split(",").map((d) => WEEKDAYS[Number(d) % 7]!);
        return `${days.slice(0, -1).join(", ")} and ${days.at(-1)} ${at}`;
      }
    } else if (/^\d+$/.test(dom) && dow === "*") {
      return `Monthly on day ${dom} ${at}`;
    }
  }
  return cron.trim();
}

/** The values one cron field allows, or null when it is not one this reads. */
function field(spec: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) return null;
    let from = lo;
    let to = hi;
    if (m[1] !== "*") {
      const [a, b] = m[1]!.split("-").map(Number) as [number, number | undefined];
      from = a;
      to = b ?? (m[2] ? hi : a);
    }
    if (from < lo || to > hi || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/**
 * When a cron next fires after `from`, in the host's own time zone (which is
 * where the scheduler runs it), as an ISO 8601 instant. Undefined for an
 * expression this does not read or one that never fires within a year.
 */
export function nextCronRun(cron: string, from: Date = new Date()): string | undefined {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [min, hr, dom, mon, dow] = [
    field(parts[0]!, 0, 59),
    field(parts[1]!, 0, 23),
    field(parts[2]!, 1, 31),
    field(parts[3]!, 1, 12),
    field(parts[4]!, 0, 7),
  ];
  if (!min || !hr || !dom || !mon || !dow) return undefined;
  if (dow.has(7)) dow.add(0);
  // Classic cron: when both day fields are restricted, either one matching is enough.
  const domAny = parts[2] === "*";
  const dowAny = parts[4] === "*";
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const dayOk =
      domAny && dowAny
        ? true
        : domAny
          ? dow.has(t.getDay())
          : dowAny
            ? dom.has(t.getDate())
            : dom.has(t.getDate()) || dow.has(t.getDay());
    if (!mon.has(t.getMonth() + 1) || !dayOk) {
      t.setHours(0, 0, 0, 0);
      t.setDate(t.getDate() + 1);
      continue;
    }
    if (!hr.has(t.getHours())) {
      t.setMinutes(0);
      t.setHours(t.getHours() + 1);
      continue;
    }
    if (min.has(t.getMinutes())) return t.toISOString();
    t.setMinutes(t.getMinutes() + 1);
  }
  return undefined;
}

import { z } from 'zod';

export const timeZoneSchema = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}, 'Use a recognized time zone.');

/** The server owns the clock; the browser supplies only its time zone. */
export function currentTimeContext(timeZone: string | undefined, now: Date) {
  const zone = timeZoneSchema.parse(timeZone ?? 'UTC');
  const formatter = new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', calendar: 'iso8601', numberingSystem: 'latn' });
  const parts = formatter.formatToParts(now);
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return { utc: now.toISOString(), time_zone: formatter.resolvedOptions().timeZone, local_date: `${part('year')}-${part('month')}-${part('day')}` };
}

export const currentTimeRule = ' The task field current_time is the server clock captured once at the start of this question, with the browser time zone when available (otherwise UTC). Use it to interpret relative dates in the current question; an explicit date or location in the question takes precedence. Do not assign this timestamp to older conversation excerpts or assume an unspecified historical date. Knowing today’s date does not verify current events, prices, laws, schedules, or source freshness. State a time-zone assumption when it materially changes the answer.';

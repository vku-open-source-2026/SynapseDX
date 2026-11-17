// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Minimal UTC cron helpers shared by scheduled jobs and scheduled reports.
 *
 * Supported fields: `*`, step (`*` + `/n`), literal, `a-b`, `a-b/n` and comma
 * lists. `@hourly`, `@daily`, `@weekly` and `@monthly` presets are normalized
 * before parsing. This deliberately avoids a dependency: the surface only
 * needs "is this minute due" and "when is the next minute due".
 */

export const CRON_RE = /^(\S+\s+){4}\S+$|^@(hourly|daily|weekly|monthly)$/;

export interface CronSchedule {
  cron?: string;
  everySeconds?: number;
}

export function cronFieldMatch(field: string, value: number): boolean {
  return field.split(',').some((part) => {
    const token = part.trim();
    if (!token) return false;
    if (token === '*') return true;
    const step = token.match(/^\*\/(\d{1,3})$/);
    if (step) return Number(step[1]) > 0 && value % Number(step[1]) === 0;
    const range = token.match(/^(\d{1,3})-(\d{1,3})(?:\/(\d{1,3}))?$/);
    if (range) {
      const [min, max, every] = [Number(range[1]), Number(range[2]), Number(range[3] || 1)];
      return every > 0 && value >= min && value <= max && (value - min) % every === 0;
    }
    return /^\d{1,3}$/.test(token) && Number(token) === value;
  });
}

export function presetCron(expr: string): string | undefined {
  if (expr === '@hourly') return '0 * * * *';
  if (expr === '@daily') return '0 0 * * *';
  if (expr === '@weekly') return '0 0 * * 0';
  if (expr === '@monthly') return '0 0 1 * *';
  return undefined;
}

export function isValidCron(expr: string): boolean {
  if (!CRON_RE.test(expr.trim())) return false;
  const normalized = presetCron(expr.trim()) || expr.trim();
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part) => part.split(',').every((token) => {
    const value = token.trim();
    if (!value) return false;
    if (value === '*') return true;
    if (/^\*\/\d{1,3}$/.test(value)) return Number(value.slice(2)) > 0;
    const range = value.match(/^(\d{1,3})-(\d{1,3})(?:\/(\d{1,3}))?$/);
    if (range) return Number(range[1]) <= Number(range[2]) && (!range[3] || Number(range[3]) > 0);
    return /^\d{1,3}$/.test(value);
  }));
}

function cronExpression(schedule: CronSchedule): string | undefined {
  return schedule.cron;
}

/** Next scheduled instant (UTC) for a supported cron/interval schedule. */
export function nextRunAt(schedule: CronSchedule, from: Date = new Date()): string {
  if (schedule.everySeconds) {
    return new Date(from.getTime() + schedule.everySeconds * 1000).toISOString();
  }
  const expr = cronExpression(schedule);
  if (!expr) return new Date(from.getTime() + 3600_000).toISOString();
  const normalized = presetCron(expr) || expr;
  const parts = normalized.trim().split(/\s+/);
  if (parts.length !== 5) return new Date(from.getTime() + 3600_000).toISOString();
  const [minute, hour, dom, month, dow] = parts;
  const start = new Date(from.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  const limit = from.getTime() + 366 * 24 * 3600 * 1000;
  for (let time = start.getTime(); time < limit; time += 60_000) {
    const date = new Date(time);
    if (!cronFieldMatch(minute, date.getUTCMinutes())) continue;
    if (!cronFieldMatch(hour, date.getUTCHours())) continue;
    if (!cronFieldMatch(dom, date.getUTCDate())) continue;
    if (!cronFieldMatch(month, date.getUTCMonth() + 1)) continue;
    if (!cronFieldMatch(dow, date.getUTCDay())) continue;
    return date.toISOString();
  }
  return new Date(from.getTime() + 3600_000).toISOString();
}

/** Next occurrence of a 5-field cron or preset expression (UTC). */
export function nextCronRun(expr: string, from: Date = new Date()): string {
  return nextRunAt({ cron: expr }, from);
}

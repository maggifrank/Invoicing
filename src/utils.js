// src/utils.js
// Shared pure utility functions — no DOM, no Supabase, no side effects.

// ── Duration ───────────────────────────────────────────────────
export function calcMinutes(from, until) {
  const [fh, fm] = from.split(':').map(Number);
  const [uh, um] = until.split(':').map(Number);
  const fromMins  = fh * 60 + fm;
  const untilMins = uh * 60 + um;
  let diff = untilMins - fromMins;
  const crossesMidnight = diff < 0;
  if (crossesMidnight) diff += 24 * 60;
  return { minutes: diff, crossesMidnight };
}

export function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatDecimalHours(minutes) {
  return (minutes / 60).toFixed(2);
}

// ── Time ───────────────────────────────────────────────────────
export function formatTime(t) {
  const [h, m] = t.split(':').map(Number);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function timeToPercent(t) {
  const [h, m] = t.split(':').map(Number);
  return ((h * 60 + m) / (24 * 60)) * 100;
}

// ── Date ───────────────────────────────────────────────────────
export function todayISO() {
  const d = new Date();
  return isoDate(d);
}

export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatDateLabel(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt        = new Date(y, mo - 1, d);
  const today     = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dt.toDateString() === today.toDateString())     return 'Today';
  if (dt.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return dt.toLocaleDateString('en-GB', {
    weekday: 'short',
    day:     'numeric',
    month:   'short',
    year:    dt.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
  });
}

export function formatMonthDay(dateStr) {
  // e.g. "21 May"
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, mo - 1, d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ── Payment cycle ──────────────────────────────────────────────
export function getCycleForDate(date, startDay) {
  const d   = new Date(date);
  const day = d.getDate();
  let cycleStart, cycleEnd;

  if (day >= startDay) {
    cycleStart = new Date(d.getFullYear(), d.getMonth(), startDay);
    cycleEnd   = new Date(d.getFullYear(), d.getMonth() + 1, startDay - 1);
  } else {
    cycleStart = new Date(d.getFullYear(), d.getMonth() - 1, startDay);
    cycleEnd   = new Date(d.getFullYear(), d.getMonth(), startDay - 1);
  }

  return { start: cycleStart, end: cycleEnd };
}

export function cyclePeriodLabel(startISO, endISO) {
  return `${formatMonthDay(startISO)} – ${formatMonthDay(endISO)}`;
}

// Groups an array of ISO date strings into payment cycle buckets.
// Returns array of { startISO, endISO, dates[] } sorted newest first.
export function bucketIntoCycles(dates, startDay) {
  const map = {};
  const out = [];

  dates.forEach(dateStr => {
    const d = new Date(dateStr + 'T12:00:00');
    const { start, end } = getCycleForDate(d, startDay);
    const key = isoDate(start);
    if (!map[key]) {
      map[key] = { startISO: key, endISO: isoDate(end), dates: [] };
      out.push(map[key]);
    }
    if (!map[key].dates.includes(dateStr)) map[key].dates.push(dateStr);
  });

  out.sort((a, b) => b.startISO.localeCompare(a.startISO));
  return out;
}

export function isCurrentCycle(startISO, endISO) {
  const today = new Date();
  const start = new Date(startISO + 'T00:00:00');
  const end   = new Date(endISO   + 'T23:59:59');
  return today >= start && today <= end;
}

// ── String ─────────────────────────────────────────────────────
export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── ISK formatting ─────────────────────────────────────────────
export function formatISK(n) {
  return Number(n).toLocaleString('is-IS') + ' ISK';
}

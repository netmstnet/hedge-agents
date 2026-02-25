'use strict';

/**
 * date-utils.cjs — Trading calendar helpers.
 */

/**
 * Returns true if the given date is a weekday (Mon-Fri).
 * Does not account for public holidays (acceptable for most markets).
 */
function isTradingDay(date) {
  const day = date.getDay();
  return day !== 0 && day !== 6; // not Sunday (0) or Saturday (6)
}

/**
 * Add N trading days to a date.
 */
function addTradingDays(date, n) {
  const d = new Date(date);
  let added = 0;
  const dir = n >= 0 ? 1 : -1;
  while (added < Math.abs(n)) {
    d.setDate(d.getDate() + dir);
    if (isTradingDay(d)) added++;
  }
  return d;
}

/**
 * Count trading days between two dates (inclusive of start, exclusive of end).
 */
function tradingDaysBetween(start, end) {
  let count = 0;
  const d = new Date(start);
  while (d < end) {
    if (isTradingDay(d)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

/**
 * Format date as YYYY-MM-DD.
 */
function toDateStr(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Parse YYYY-MM-DD string to Date (UTC noon to avoid timezone shifts).
 */
function fromDateStr(str) {
  return new Date(str + 'T12:00:00Z');
}

/**
 * Unix timestamp (seconds) from Date.
 */
function toUnixSec(date) {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Generate array of trading days between start and end.
 */
function tradingDayRange(start, end) {
  const days = [];
  const d = new Date(start);
  while (d <= end) {
    if (isTradingDay(d)) days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

module.exports = {
  isTradingDay,
  addTradingDays,
  tradingDaysBetween,
  toDateStr,
  fromDateStr,
  toUnixSec,
  tradingDayRange,
};

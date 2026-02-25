'use strict';

/**
 * logger.cjs — Structured console logger.
 * Same pattern as BrewBoard. Levels: debug | info | warn | error
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = {
  debug: '\x1b[36m', // cyan
  info:  '\x1b[32m', // green
  warn:  '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  reset: '\x1b[0m',
};

const minLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 1;

function log(level, module, message, data) {
  if (LEVELS[level] < minLevel) return;
  const ts   = new Date().toISOString();
  const col  = COLORS[level] || '';
  const rst  = COLORS.reset;
  const mod  = module ? `[${module}] ` : '';
  const msg  = typeof message === 'object' ? JSON.stringify(message) : message;
  const extra = data !== undefined ? ' ' + (typeof data === 'object' ? JSON.stringify(data) : data) : '';
  // eslint-disable-next-line no-console
  console.log(`${col}${ts} ${level.toUpperCase().padEnd(5)} ${mod}${msg}${extra}${rst}`);
}

module.exports = {
  debug: (mod, msg, data) => log('debug', mod, msg, data),
  info:  (mod, msg, data) => log('info',  mod, msg, data),
  warn:  (mod, msg, data) => log('warn',  mod, msg, data),
  error: (mod, msg, data) => log('error', mod, msg, data),
};

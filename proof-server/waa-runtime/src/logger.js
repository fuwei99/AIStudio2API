'use strict';

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };

function createLogger(options = {}) {
  const level = typeof options.level === 'string'
    ? (LEVELS[options.level] ?? LEVELS.info)
    : (options.level ?? LEVELS.info);
  const prefix = options.prefix || 'waa';
  const sink = options.sink || ((line) => process.stderr.write(line + '\n'));
  const time = options.time !== false;

  function emit(lvl, args) {
    if (LEVELS[lvl] > level) return;
    const stamp = time ? new Date().toISOString().slice(11, 23) : '';
    const text = args.map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    sink(`${stamp ? stamp + ' ' : ''}${prefix} ${lvl.toUpperCase().padEnd(5)} ${text}`);
  }

  return {
    level,
    error: (...a) => emit('error', a),
    warn: (...a) => emit('warn', a),
    info: (...a) => emit('info', a),
    debug: (...a) => emit('debug', a),
    trace: (...a) => emit('trace', a),
    child: (p) => createLogger({ ...options, prefix: `${prefix}:${p}`, level }),
  };
}

module.exports = { createLogger, LEVELS };

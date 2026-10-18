import type { LogLevel } from '../config/env';

type Level = Exclude<LogLevel, 'silent'>;
type Fields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function serialise(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value;
  }
  return out;
}

/**
 * Dependency-free structured logger. Emits one JSON object per line in
 * production (for log aggregation) and a compact human-readable line otherwise.
 */
export function createLogger({ level, json }: { level: LogLevel; json: boolean }): Logger {
  const threshold = SEVERITY[level];

  const write = (lvl: Level, message: string, fields: Fields = {}) => {
    if (SEVERITY[lvl] < threshold) return;
    const stream = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    const data = serialise(fields);

    if (json) {
      stream.write(
        `${JSON.stringify({ time: new Date().toISOString(), level: lvl, message, ...data })}\n`,
      );
      return;
    }
    const extra = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
    stream.write(
      `${new Date().toISOString().slice(11, 23)} ${lvl.toUpperCase().padEnd(5)} ${message}${extra}\n`,
    );
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

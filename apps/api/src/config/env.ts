import { z } from 'zod';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;

const originList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(
    z.array(
      z.string().refine((origin) => {
        try {
          return new URL(origin).origin === origin;
        } catch {
          return false;
        }
      }, 'Each CORS origin must be a bare origin such as http://localhost:3000'),
    ),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(4000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  CORS_ORIGINS: originList.default([
    'http://localhost:3000',
    'http://localhost:5173',
    'tauri://localhost',
    'http://tauri.localhost',
  ]),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  host: string;
  port: number;
  logLevel: LogLevel;
  corsOrigins: readonly string[];
  shutdownTimeoutMs: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Parses and validates configuration. Throws `ConfigError` listing every invalid variable. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${problems}`);
  }

  const env = result.data;
  return Object.freeze({
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    corsOrigins: Object.freeze(env.CORS_ORIGINS),
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  });
}

import pino from "pino";

/** Shared structured logger. Level via LOG_LEVEL (default info). */
export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "keeper" },
});

export type Logger = typeof log;

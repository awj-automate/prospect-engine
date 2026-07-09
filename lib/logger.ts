/**
 * Minimal structured logger. Emits single-line JSON so Railway log search
 * stays useful. Never throws.
 */

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, scope: string, msg: string, data?: unknown) {
  const record: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    scope,
    msg,
  };
  if (data !== undefined) {
    if (data instanceof Error) {
      record.error = { name: data.name, message: data.message, stack: data.stack };
    } else {
      record.data = data;
    }
  }
  const line = safeStringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "log serialize failed" });
  }
}

export interface Logger {
  debug: (msg: string, data?: unknown) => void;
  info: (msg: string, data?: unknown) => void;
  warn: (msg: string, data?: unknown) => void;
  error: (msg: string, data?: unknown) => void;
  child: (childScope: string) => Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg, data) => emit("debug", scope, msg, data),
    info: (msg, data) => emit("info", scope, msg, data),
    warn: (msg, data) => emit("warn", scope, msg, data),
    error: (msg, data) => emit("error", scope, msg, data),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

export const log = createLogger("app");

/**
 * Whirlwind SSH — Logger Abstraction
 *
 * Default: console. Drop-in replacements:
 *   - electron-log: setLogger(electronLog)
 *   - pino:         setLogger(pino())
 *   - winston:      setLogger(winstonInstance)
 *   - silent:       setLogger(SILENT_LOGGER)
 *
 * Any object with debug/info/warn/error methods works.
 */

export interface WhirlwindLogger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

/**
 * Console-based logger (default).
 * Prefixes all messages with [whirlwind-ssh] for easy grep.
 */
const CONSOLE_LOGGER: WhirlwindLogger = {
  debug: (msg, ...args) => console.debug(`[whirlwind-ssh] ${msg}`, ...args),
  info: (msg, ...args) => console.info(`[whirlwind-ssh] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[whirlwind-ssh] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[whirlwind-ssh] ${msg}`, ...args),
};

/**
 * Silent logger — suppresses all output.
 * Useful for tests or embedded usage where you handle events directly.
 */
export const SILENT_LOGGER: WhirlwindLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let currentLogger: WhirlwindLogger = CONSOLE_LOGGER;

/**
 * Set the logger used by all Whirlwind SSH components.
 *
 * @example
 *   // Electron
 *   import log from 'electron-log';
 *   setLogger(log);
 *
 *   // Pino
 *   import pino from 'pino';
 *   setLogger(pino());
 *
 *   // Silent
 *   import { setLogger, SILENT_LOGGER } from 'whirlwind-ssh';
 *   setLogger(SILENT_LOGGER);
 */
export function setLogger(logger: WhirlwindLogger): void {
  currentLogger = logger;
}

/**
 * Get the current logger instance.
 * Used internally by all modules — never import a logger directly.
 */
export function getLogger(): WhirlwindLogger {
  return currentLogger;
}
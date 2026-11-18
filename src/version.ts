declare const __TASKLOG_VERSION__: string | undefined;

/** Informational semver; injected at bundle time, with a dev fallback under Vitest. */
export const VERSION: string = typeof __TASKLOG_VERSION__ === 'undefined' ? '0.0.0-dev' : __TASKLOG_VERSION__;

/** One integer protocol; within a number, changes are additive only (spec section 2). */
export const PROTOCOL = 1;

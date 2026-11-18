import fs from 'node:fs';
import { createLogger, daemonLoggerOptions, parseLevel } from '../log.ts';
import { dataPaths } from '../paths.ts';
import { AlreadyRunningError, startDaemon } from './core.ts';

/** Runs the daemon in this process until it exits. Shared by `tasklog serve` and the spawned entry. */
export async function runDaemonProcess(opts: { foreground?: boolean; verbose?: boolean } = {}): Promise<number> {
  const paths = dataPaths();
  fs.mkdirSync(paths.logsDir, { recursive: true });
  const log = createLogger({
    file: paths.daemonLog,
    level: opts.verbose ? 'debug' : parseLevel(process.env.TASKLOG_LOG_LEVEL),
    stderr: opts.foreground,
    ...daemonLoggerOptions,
  });
  try {
    const d = await startDaemon({ paths, log });
    const stop = (sig: string) => void d.shutdown(sig);
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    await d.stopped;
    return 0;
  } catch (e) {
    if (e instanceof AlreadyRunningError) {
      log.info('daemon.already_running');
      return 0;
    }
    log.error('daemon.start_failed', { error: (e as Error).message });
    process.stderr.write(`tasklog daemon failed to start: ${(e as Error).message}\n`);
    return 1;
  }
}

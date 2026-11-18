import os from 'node:os';
import path from 'node:path';

/**
 * Data directory: `TASKLOG_HOME` if set (tests, relocation), else `%LOCALAPPDATA%\tasklog`
 * (machine-local state, so Local rather than Roaming). Non-Windows falls back to XDG-style.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TASKLOG_HOME) return path.resolve(env.TASKLOG_HOME);
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'tasklog');
  }
  return path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'tasklog');
}

export interface DataPaths {
  dir: string;
  daemonJson: string;
  lock: string;
  workspacesJson: string;
  logsDir: string;
  daemonLog: string;
  shimLog: string;
}

export function dataPaths(dir: string = dataDir()): DataPaths {
  const logsDir = path.join(dir, 'logs');
  return {
    dir,
    daemonJson: path.join(dir, 'daemon.json'),
    lock: path.join(dir, 'daemon.lock'),
    workspacesJson: path.join(dir, 'workspaces.json'),
    logsDir,
    daemonLog: path.join(logsDir, 'daemon.log'),
    shimLog: path.join(logsDir, 'shim.log'),
  };
}

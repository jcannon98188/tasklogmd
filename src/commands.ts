import { probeDaemon, stopDaemon } from './client.ts';
import { runDaemonProcess } from './daemon/run.ts';
import { runDoctor } from './doctor.ts';
import { createLogger, parseLevel, shimLoggerOptions } from './log.ts';
import { dataPaths } from './paths.ts';
import { runShim } from './shim.ts';
import { PROTOCOL, VERSION } from './version.ts';
import fs from 'node:fs';

/** Exit codes (spec section 8). */
export const EXIT = { ok: 0, failed: 1, usage: 2, noDaemon: 3, protocol: 4 } as const;

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: string;
  /** Test seam: start a daemon instead of the real detached spawn. */
  spawn?: () => void;
}

const USAGE = `usage: tasklog <command>
  shim [--workspace <path>]   stdio MCP entry point
  serve [--verbose]           run the daemon in the foreground
  status [--json]             report daemon state (exit 3 if none running)
  stop                        stop the daemon (no-op if stopped)
  doctor [--json]             verify the install
  --version                   print version and protocol
`;

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}
function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runCommand(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  const paths = dataPaths();
  const json = flag(rest, '--json');

  switch (cmd) {
    case '--version':
    case '-v':
      io.stdout(`tasklog ${VERSION} (protocol ${PROTOCOL})\n`);
      return EXIT.ok;

    case 'serve':
      return runDaemonProcess({ foreground: true, verbose: flag(rest, '--verbose') });

    case 'shim': {
      fs.mkdirSync(paths.logsDir, { recursive: true });
      const log = createLogger({ file: paths.shimLog, level: parseLevel(process.env.TASKLOG_LOG_LEVEL), ...shimLoggerOptions });
      await runShim({ input: process.stdin, output: process.stdout, cwd: io.cwd, workspace: option(rest, '--workspace'), paths, log, spawn: io.spawn });
      return EXIT.ok;
    }

    case 'status': {
      const probe = await probeDaemon(paths);
      if (!probe) {
        if (json) io.stdout(JSON.stringify({ running: false }) + '\n');
        else io.stdout('tasklog daemon is not running\n');
        return EXIT.noDaemon;
      }
      const h = probe.health;
      if (json) io.stdout(JSON.stringify({ running: true, pid: h.pid, port: probe.state.port, version: h.version, protocol: h.protocol, uptime: h.uptime, workspaces: h.workspaces }) + '\n');
      else
        io.stdout(
          `tasklog daemon running: pid ${h.pid}, port ${probe.state.port}, version ${h.version}, protocol ${h.protocol}, up ${h.uptime}s, ${h.workspaces.length} workspace(s)\n`,
        );
      return EXIT.ok;
    }

    case 'stop': {
      const was = await stopDaemon(paths);
      io.stdout(was ? 'tasklog daemon stopped\n' : 'tasklog daemon was not running\n');
      return EXIT.ok;
    }

    case 'doctor': {
      fs.mkdirSync(paths.logsDir, { recursive: true });
      const log = createLogger({ file: paths.shimLog, ...shimLoggerOptions });
      const checks = await runDoctor({ paths, log, cwd: io.cwd, spawn: io.spawn });
      const failed = checks.some((c) => !c.ok);
      if (json) io.stdout(JSON.stringify({ ok: !failed, checks }) + '\n');
      else {
        for (const c of checks) io.stdout(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}${c.ok || !c.fix ? '' : `\n     fix: ${c.fix}`}\n`);
        io.stdout(`logs: ${paths.logsDir}\n`);
      }
      return failed ? EXIT.failed : EXIT.ok;
    }

    default:
      io.stderr(USAGE);
      return cmd === '--help' || cmd === '-h' ? EXIT.ok : EXIT.usage;
  }
}

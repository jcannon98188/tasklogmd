import fs from 'node:fs';
import path from 'node:path';
import { callDaemon, ensureDaemon, EnsureDaemonError, probeDaemon, stopDaemon, type Probe } from './client.ts';
import { runDaemonProcess } from './daemon/run.ts';
import { runDoctor } from './doctor.ts';
import { formatReport, ImportUsageError, runImport } from './import/import.ts';
import { createLogger, parseLevel, shimLoggerOptions, type Logger } from './log.ts';
import { dataPaths, type DataPaths } from './paths.ts';
import { runShim } from './shim.ts';
import { PROTOCOL, VERSION } from './version.ts';
import { canonicalize, findWorkspaceRoot, TASKLOG_DIR } from './workspaces.ts';

/** Exit codes (spec section 8). */
export const EXIT = { ok: 0, failed: 1, usage: 2, noDaemon: 3, protocol: 4 } as const;

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: string;
  /** Test seam: start a daemon instead of the real detached spawn. */
  spawn?: () => void;
  /** Test seam: data directory layout (defaults to `dataPaths()`, i.e. TASKLOG_HOME or %LOCALAPPDATA%\tasklog). */
  paths?: DataPaths;
  /** Test seam: environment for PATH lookups (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

const USAGE = `usage: tasklog <command> [options]
  shim [--workspace <path>]            stdio MCP entry point
  serve [--verbose]                    run the daemon in the foreground
  start                                start the daemon detached and wait until healthy
  stop                                 stop the daemon (no-op if stopped)
  status [--json] [--workspace <p>]    report daemon state (exit 3 if none running)
  init [--workspace <path>]            create .tasklog/ and register the workspace
  add <path>                           register a workspace
  remove <path>                        unregister a workspace
  list [--json] [--workspace <p>]      list registered workspaces
  import <path> [--dry-run] [--json] [--effort <name>] [--group-by none]
                                       convert a backlog or scratch layout into .tasklog/
  doctor [--json] [--workspace <p>]    verify the install
  --version                            print version and protocol
exit codes: 0 ok, 1 failed, 2 usage, 3 no daemon (status), 4 daemon newer than this CLI
`;

/** Which flags and how many positionals each command takes. */
const SPEC: Record<string, { flags: string[]; values: string[]; positionals: number }> = {
  shim: { flags: [], values: ['--workspace'], positionals: 0 },
  serve: { flags: ['--verbose'], values: [], positionals: 0 },
  start: { flags: [], values: [], positionals: 0 },
  stop: { flags: [], values: [], positionals: 0 },
  status: { flags: ['--json'], values: ['--workspace'], positionals: 0 },
  init: { flags: [], values: ['--workspace'], positionals: 0 },
  add: { flags: [], values: [], positionals: 1 },
  remove: { flags: [], values: [], positionals: 1 },
  list: { flags: ['--json'], values: ['--workspace'], positionals: 0 },
  doctor: { flags: ['--json'], values: ['--workspace'], positionals: 0 },
  import: { flags: ['--json', '--dry-run'], values: ['--effort', '--group-by'], positionals: 1 },
};

interface Parsed {
  flags: Set<string>;
  values: Record<string, string>;
  positionals: string[];
}

class UsageError extends Error {}

function parseArgs(cmd: string, args: string[]): Parsed {
  const spec = SPEC[cmd]!;
  const out: Parsed = { flags: new Set(), values: {}, positionals: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (spec.flags.includes(a)) out.flags.add(a);
    else if (spec.values.includes(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      out.values[a] = v;
    } else if (a.startsWith('-')) throw new UsageError(`unknown option ${a} for "${cmd}"`);
    else out.positionals.push(a);
  }
  if (out.positionals.length !== spec.positionals) {
    throw new UsageError(spec.positionals ? `"${cmd}" takes exactly ${spec.positionals} path argument` : `"${cmd}" takes no arguments`);
  }
  return out;
}

function openLog(paths: DataPaths): Logger {
  return createLogger({ file: paths.shimLog, level: parseLevel(process.env.TASKLOG_LOG_LEVEL), ...shimLoggerOptions });
}

function errorMessage(body: unknown, fallback: string): string {
  const m = (body as { error?: { message?: string } } | null)?.error?.message;
  return m ?? fallback;
}

export async function runCommand(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === '--version' || cmd === '-v') {
    io.stdout(`tasklog ${VERSION} (protocol ${PROTOCOL})\n`);
    return EXIT.ok;
  }
  if (cmd === '--help' || cmd === '-h') {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  if (!cmd || !(cmd in SPEC)) {
    io.stderr(cmd ? `tasklog: unknown command "${cmd}"\n${USAGE}` : USAGE);
    return EXIT.usage;
  }

  let args: Parsed;
  try {
    args = parseArgs(cmd, rest);
  } catch (e) {
    io.stderr(`tasklog: ${(e as Error).message}\n${USAGE}`);
    return EXIT.usage;
  }

  const paths = io.paths ?? dataPaths();
  const json = args.flags.has('--json');
  const wsOpt = args.values['--workspace'];
  const wsDir = path.resolve(io.cwd, wsOpt ?? '.');
  const out = (s: string) => io.stdout(s + '\n');
  const fail = (s: string, code: number = EXIT.failed) => {
    io.stderr(`tasklog: ${s}\n`);
    return code;
  };

  const usageFail = (s: string) => fail(s, EXIT.usage);

  /** Finds a compatible daemon or starts one. A newer daemon yields exit 4 (the caller returns the code). */
  async function needDaemon(): Promise<{ probe: Probe } | { code: number }> {
    try {
      return { probe: (await ensureDaemon({ paths, log: openLog(paths), spawn: io.spawn })).probe };
    } catch (e) {
      if (e instanceof EnsureDaemonError && e.kind === 'daemon_newer_than_shim') {
        return { code: fail('the running daemon is newer than this tasklog; upgrade tasklog (npm i -g tasklog).', EXIT.protocol) };
      }
      return { code: fail((e as Error).message) };
    }
  }

  switch (cmd) {
    case 'serve':
      return runDaemonProcess({ foreground: true, verbose: args.flags.has('--verbose') });

    case 'shim': {
      const log = openLog(paths);
      await runShim({ input: process.stdin, output: process.stdout, cwd: io.cwd, workspace: wsOpt, paths, log, spawn: io.spawn });
      return EXIT.ok;
    }

    case 'start': {
      const d = await needDaemon();
      if ('code' in d) return d.code;
      out(`tasklog daemon running: pid ${d.probe.health.pid}, port ${d.probe.state.port}`);
      return EXIT.ok;
    }

    case 'status': {
      const probe = await probeDaemon(paths);
      const root = wsOpt ? wsDir : findWorkspaceRoot(io.cwd);
      if (!probe) {
        if (json) out(JSON.stringify({ running: false }));
        else out('tasklog daemon is not running');
        return EXIT.noDaemon;
      }
      const h = probe.health;
      let registered: boolean | null = null;
      if (root) {
        try {
          const c = canonicalize(root);
          registered = h.workspaces.some((w) => w.root === c);
        } catch {
          registered = false;
        }
      }
      if (json) {
        out(
          JSON.stringify({
            running: true,
            pid: h.pid,
            port: probe.state.port,
            version: h.version,
            protocol: h.protocol,
            uptime: h.uptime,
            workspaces: h.workspaces,
            workspace: root ? { root, registered } : null,
          }),
        );
      } else {
        out(`tasklog daemon running: pid ${h.pid}, port ${probe.state.port}, version ${h.version}, protocol ${h.protocol}, up ${h.uptime}s, ${h.workspaces.length} workspace(s)`);
        if (root) out(`workspace ${root}: ${registered ? 'registered' : 'not registered'}`);
      }
      return EXIT.ok;
    }

    case 'stop': {
      const was = await stopDaemon(paths);
      out(was ? 'tasklog daemon stopped' : 'tasklog daemon was not running');
      return EXIT.ok;
    }

    case 'init': {
      const probe = await probeDaemon(paths);
      if (probe && probe.health.protocol > PROTOCOL) {
        return fail('the running daemon is newer than this tasklog; upgrade tasklog (npm i -g tasklog).', EXIT.protocol);
      }
      if (probe) {
        const r = await callDaemon<{ root?: string }>(probe.state, 'POST', '/workspaces', { body: { root: wsDir, init: true }, protocol: probe.health.protocol });
        if (r.status !== 200) return fail(errorMessage(r.body, `init failed (HTTP ${r.status})`));
        out(`initialised and registered ${r.body.root}`);
        return EXIT.ok;
      }
      try {
        fs.mkdirSync(path.join(wsDir, TASKLOG_DIR), { recursive: true });
      } catch (e) {
        return fail(`cannot create ${TASKLOG_DIR} in ${wsDir}: ${(e as Error).message}`);
      }
      out(`initialised ${wsDir}; it is registered on the first shim connection`);
      return EXIT.ok;
    }

    case 'add':
    case 'remove': {
      const d = await needDaemon();
      if ('code' in d) return d.code;
      const target = path.resolve(io.cwd, args.positionals[0]!);
      const r = await callDaemon<{ root?: string; removed?: boolean }>(d.probe.state, cmd === 'add' ? 'POST' : 'DELETE', '/workspaces', { body: { root: target } });
      if (r.status !== 200) return fail(errorMessage(r.body, `${cmd} failed (HTTP ${r.status})`));
      if (cmd === 'add') out(`registered ${r.body.root}`);
      else out(r.body.removed ? `removed ${target}` : `${target} was not registered`);
      return EXIT.ok;
    }

    case 'list': {
      const d = await needDaemon();
      if ('code' in d) return d.code;
      const r = await callDaemon<{ workspaces: Array<{ root: string; state: string }> }>(d.probe.state, 'GET', '/workspaces');
      if (r.status !== 200) return fail(errorMessage(r.body, `list failed (HTTP ${r.status})`));
      let list = r.body.workspaces;
      if (wsOpt) {
        let c = wsDir;
        try {
          c = canonicalize(wsDir);
        } catch {
          /* match as given */
        }
        list = list.filter((w) => w.root === c);
      }
      if (json) out(JSON.stringify({ workspaces: list }));
      else if (list.length === 0) out('no workspaces registered');
      else for (const w of list) out(`${w.root}  ${w.state}`);
      return EXIT.ok;
    }

    case 'import': {
      const effort = args.values['--effort'];
      const groupBy = args.values['--group-by'];
      if (effort !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(effort)) {
        return usageFail(`--effort must be a lowercase kebab-case name, got "${effort}"`);
      }
      if (groupBy !== undefined && groupBy !== 'none' && groupBy !== 'milestone') {
        return usageFail(`--group-by must be "none" or "milestone", got "${groupBy}"`);
      }
      try {
        // In-process and offline: no daemon is started or contacted.
        const rep = runImport({ path: args.positionals[0]!, cwd: io.cwd, dryRun: args.flags.has('--dry-run'), effort, groupBy });
        out(json ? JSON.stringify(rep) : formatReport(rep));
        return rep.skipped.length > 0 ? EXIT.failed : EXIT.ok;
      } catch (e) {
        if (e instanceof ImportUsageError) return usageFail(e.message);
        return fail(`import failed: ${(e as Error).message}`);
      }
    }

    case 'doctor': {
      const log = openLog(paths);
      const rep = await runDoctor({ paths, log, cwd: io.cwd, workspace: wsOpt, env: io.env, spawn: io.spawn });
      const failed = rep.checks.some((c) => !c.ok);
      if (json) {
        out(JSON.stringify({ ok: !failed, checks: rep.checks, problems: rep.problems, recent_events: rep.recent_events, recent_log: rep.recent_log, logs: paths.logsDir, log_files: { daemon: paths.daemonLog, shim: paths.shimLog } }));
      } else {
        for (const c of rep.checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}${c.ok || !c.fix ? '' : `\n     fix: ${c.fix}`}`);
        for (const p of rep.problems) out(`problem: ${JSON.stringify(p)}`);
        for (const e of rep.recent_events) out(`event: ${JSON.stringify(e)}`);
        for (const l of rep.recent_log) out(`log: ${l}`);
        out(`logs: ${paths.logsDir}`);
        out(`daemon log: ${paths.daemonLog}`);
        out(`shim log: ${paths.shimLog}`);
      }
      if (rep.daemonNewer) return EXIT.protocol;
      return failed ? EXIT.failed : EXIT.ok;
    }
  }
  return EXIT.usage;
}

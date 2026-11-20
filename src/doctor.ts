import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDaemon, EnsureDaemonError, type HealthBody } from './client.ts';
import { pidAlive } from './fsutil.ts';
import type { Logger } from './log.ts';
import { callTool } from './mcp-call.ts';
import type { DataPaths } from './paths.ts';
import { readDaemonState, type DaemonState } from './state.ts';
import { PROTOCOL } from './version.ts';
import { findWorkspaceRoot } from './workspaces.ts';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** Current invalid and conflicted items of the resolved workspace (empty when the daemon is down). */
  problems: unknown[];
  recent_events: unknown[];
  /** Last warn/error lines of daemon.log, only filled when the daemon was unreachable. */
  recent_log: string[];
  /** The running daemon speaks a newer protocol than this CLI (exit 4). */
  daemonNewer: boolean;
}

export interface DoctorOptions {
  paths: DataPaths;
  log: Logger;
  cwd: string;
  /** `--workspace <path>` in place of the working directory. */
  workspace?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: () => void;
  /** Node version to check; defaults to process.versions.node (injected by tests). */
  nodeVersion?: string;
}

function writable(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `.doctor-${process.pid}.tmp`);
    fs.writeFileSync(f, 'x');
    fs.rmSync(f);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const f = path.join(d, name + e);
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

function lastProblemLines(file: string, n: number): string[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => /"level":"(warn|error)"/.test(l))
      .slice(-n);
  } catch {
    return [];
  }
}

/** One informational line (never a failure): elements exist but the repo's tracker doc lacks the Architecture section. */
function architectureGuidanceCheck(root: string, counts: { containers?: number; components?: number } | undefined): DoctorCheck {
  const elements = (counts?.containers ?? 0) + (counts?.components ?? 0);
  const name = 'architecture-guidance';
  if (elements === 0) return { name, ok: true, detail: 'no architecture elements', fix: '' };
  let doc = '';
  try {
    doc = fs.readFileSync(path.join(root, 'docs', 'agents', 'issue-tracker.md'), 'utf8');
  } catch {
    /* absent counts as no section */
  }
  if (/^## Architecture[ \t]*\r?$/m.test(doc)) return { name, ok: true, detail: 'docs/agents/issue-tracker.md has an Architecture section', fix: '' };
  return { name, ok: true, detail: 'warning: architecture elements exist but docs/agents/issue-tracker.md has no "## Architecture" section; refresh it from the TaskLog setup template so agents learn the tools.', fix: '' };
}

/** Full doctor (spec section 8). Starts the daemon if needed; `status` is the non-starting probe. */
export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const { paths } = opts;
  const env = opts.env ?? process.env;
  const checks: DoctorCheck[] = [];
  const report: DoctorReport = { checks, problems: [], recent_events: [], recent_log: [], daemonNewer: false };

  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const major = Number(nodeVersion.split('.')[0]);
  checks.push({ name: 'node-version', ok: major >= 24, detail: `Node ${nodeVersion}`, fix: 'Install Node 24 or newer.' });

  for (const [name, dir] of [['data-dir-writable', paths.dir], ['log-dir-writable', paths.logsDir]] as const) {
    const err = writable(dir);
    checks.push({ name, ok: !err, detail: err ?? dir, fix: `Make ${dir} writable by the current user.` });
  }

  // daemon.json: fresh (describes a live daemon), absent, or stale. Judged before ensureDaemon replaces it.
  const pre = readDaemonState(paths);
  if (!pre) {
    checks.push({
      name: 'daemon-json',
      ok: !fs.existsSync(paths.daemonJson),
      detail: fs.existsSync(paths.daemonJson) ? `${paths.daemonJson} is unreadable or malformed` : 'no daemon.json (no daemon running)',
      fix: `Delete ${paths.daemonJson}, or run "tasklog stop".`,
    });
  } else if (!pidAlive(pre.pid)) {
    checks.push({ name: 'daemon-json', ok: false, detail: `stale: pid ${pre.pid} is not running`, fix: `Delete ${paths.daemonJson} (the next start replaces it).` });
  } else {
    checks.push({ name: 'daemon-json', ok: true, detail: `fresh: pid ${pre.pid}, port ${pre.port}`, fix: '' });
  }

  // workspaces.json: must be readable and well-formed. Judged before the daemon starts and sets a corrupt file aside.
  if (fs.existsSync(paths.workspacesJson)) {
    let detail = '';
    try {
      const parsed = JSON.parse(fs.readFileSync(paths.workspacesJson, 'utf8'));
      if (!parsed || !Array.isArray(parsed.workspaces)) throw new Error('unexpected shape');
      detail = `${parsed.workspaces.length} registered`;
    } catch (e) {
      detail = `${paths.workspacesJson} is unreadable: ${(e as Error).message}`;
    }
    const ok = /registered$/.test(detail);
    checks.push({ name: 'workspaces-readable', ok, detail, fix: 'Run "tasklog stop"; a corrupt workspaces.json is set aside (.bak) on the next start.' });
  } else {
    checks.push({ name: 'workspaces-readable', ok: true, detail: 'no workspaces.json yet (0 registered)', fix: '' });
  }

  let health: HealthBody | null = null;
  let state: DaemonState | null = null;
  try {
    const r = await ensureDaemon({ paths, log: opts.log, spawn: opts.spawn });
    health = r.probe.health;
    state = r.probe.state;
    checks.push({
      name: 'daemon-health',
      ok: true,
      detail: `pid ${health.pid}, up ${health.uptime}s${r.action === 'reused' ? '' : ` (${r.action})`}`,
      fix: '',
    });
    checks.push({ name: 'protocol', ok: true, detail: `protocol ${health.protocol}, version ${health.version}`, fix: '' });
  } catch (e) {
    const newer = e instanceof EnsureDaemonError && e.kind === 'daemon_newer_than_shim';
    report.daemonNewer = newer;
    checks.push({
      name: 'daemon-health',
      ok: newer,
      detail: newer ? 'daemon is running (newer protocol)' : (e as Error).message,
      fix: newer ? '' : 'Run "tasklog serve" in a terminal to see why the daemon will not start.',
    });
    checks.push({
      name: 'protocol',
      ok: false,
      detail: newer ? `daemon protocol is newer than ${PROTOCOL}` : 'daemon unreachable',
      fix: newer ? 'Upgrade tasklog (npm i -g tasklog).' : 'Fix the daemon-health check first.',
    });
    if (!newer) report.recent_log = lastProblemLines(paths.daemonLog, 10);
  }

  const wsArg = opts.workspace ? path.resolve(opts.cwd, opts.workspace) : null;
  const root = wsArg && fs.existsSync(path.join(wsArg, '.tasklog')) ? wsArg : wsArg ? null : findWorkspaceRoot(opts.cwd);
  checks.push({
    name: 'workspace-resolves',
    ok: true, // informational: not being in a workspace is not an install fault
    detail: root ? `workspace ${root}` : wsArg ? `${wsArg} has no .tasklog/ directory` : 'current directory is not inside a .tasklog/ workspace',
    fix: root ? '' : 'Run "tasklog init" (or the init_workspace tool) to create one.',
  });

  if (root && state && !report.daemonNewer) {
    try {
      const r = await callTool(state, 'workspace_status', {}, { workspace: root });
      const s = r.structuredContent ?? {};
      if (r.isError) throw new Error(s.error?.message ?? 'workspace_status failed');
      report.problems = Array.isArray(s.problems) ? s.problems : [];
      report.recent_events = Array.isArray(s.recent_events) ? s.recent_events : [];
      checks.push(architectureGuidanceCheck(root, s.architecture));
      checks.push({
        name: 'workspace-problems',
        ok: report.problems.length === 0,
        detail: report.problems.length === 0 ? 'no invalid or conflicted items' : `${report.problems.length} invalid or conflicted item(s)`,
        fix: 'Open the listed files and correct them; see "problems" below and the daemon log.',
      });
    } catch (e) {
      checks.push({ name: 'workspace-problems', ok: false, detail: (e as Error).message, fix: 'Run "tasklog stop" and retry.' });
    }
  }

  // claude on PATH and tasklog registered; skipped (not failed) when claude is absent.
  const claude = findOnPath('claude', env);
  if (!claude) {
    checks.push({ name: 'claude-mcp', ok: true, detail: 'skipped: claude is not on PATH', fix: '' });
  } else {
    try {
      const out = execFileSync(claude, ['mcp', 'list'], { encoding: 'utf8', timeout: 20_000, windowsHide: true, shell: /\.(cmd|bat)$/i.test(claude), env, stdio: ['ignore', 'pipe', 'ignore'] });
      const has = /^\s*tasklog\b/im.test(out);
      checks.push({
        name: 'claude-mcp',
        ok: has,
        detail: has ? 'tasklog is registered with claude' : 'claude is installed but tasklog is not in "claude mcp list"',
        fix: 'Run: claude mcp add --scope user tasklog -- tasklog shim',
      });
    } catch (e) {
      checks.push({ name: 'claude-mcp', ok: false, detail: `"claude mcp list" failed: ${(e as Error).message.split('\n')[0]}`, fix: 'Run "claude mcp list" yourself to see the error.' });
    }
  }

  return report;
}

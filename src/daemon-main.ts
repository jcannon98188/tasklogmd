// Entry point of the spawned daemon (bundled to dist/daemon.js).
import { runDaemonProcess } from './daemon/run.ts';

process.exit(await runDaemonProcess());

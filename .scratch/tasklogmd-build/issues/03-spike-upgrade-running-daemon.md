# 03: Spike: upgrade with a running daemon

**What to build:** A throwaway, scripted spike that answers open verification item V2: what happens when `npm i -g` replaces the package while a daemon from the old version is running on Windows, and does a newer shim then restart it. Spec reference: `.scratch/tasklogmd/spec.md`, sections 2 (Versioning), 11 (Build rules) and 13 (Spike 3).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] Two versions of a stub package exist (old and new protocol integer), each with a stub daemon bundled as one ESM file and a stub shim implementing the protocol-mismatch restart from the spec.
- [x] Given the old daemon running, when `npm i -g` installs the new version over it, then the install succeeds, or the exact failure and locked file are reported.
- [x] Given a successful install, when the old daemon is queried, then it keeps serving requests.
- [x] Given the new shim connects to the old daemon, when it sees the protocol mismatch, then the daemon drains and exits and the new daemon starts without a lazy-load error.
- [x] Given an older shim facing the newer daemon, when it connects, then it errors and does not restart the daemon.
- [x] The result is recorded as the answer to V2 in section 13 of the spec, and the upgrade steps in section 11 are confirmed or corrected.

## Comments

Spike run via `node spikes/03-upgrade/run.mjs` (writes `spikes/03-upgrade/last-run.json`). Stub package/bin `tasklogspike3`. Result: replace succeeds, old daemon keeps serving, newer shim restarts it, older shim errors. Constraint found: daemon cwd inside the package dir => `npm i -g` fails EBUSY. Recorded in spec sections 11 and 13. Not verified: real-bundle behaviour, AV/indexer locks, in-flight request during upgrade. Machine cleaned up (stub uninstalled, daemons killed).

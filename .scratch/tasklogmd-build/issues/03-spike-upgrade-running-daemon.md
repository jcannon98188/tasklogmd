# 03: Spike: upgrade with a running daemon

**What to build:** A throwaway, scripted spike that answers open verification item V2: what happens when `npm i -g` replaces the package while a daemon from the old version is running on Windows, and does a newer shim then restart it. Spec reference: `.scratch/tasklogmd/spec.md`, sections 2 (Versioning), 11 (Build rules) and 13 (Spike 3).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Two versions of a stub package exist (old and new protocol integer), each with a stub daemon bundled as one ESM file and a stub shim implementing the protocol-mismatch restart from the spec.
- [ ] Given the old daemon running, when `npm i -g` installs the new version over it, then the install succeeds, or the exact failure and locked file are reported.
- [ ] Given a successful install, when the old daemon is queried, then it keeps serving requests.
- [ ] Given the new shim connects to the old daemon, when it sees the protocol mismatch, then the daemon drains and exits and the new daemon starts without a lazy-load error.
- [ ] Given an older shim facing the newer daemon, when it connects, then it errors and does not restart the daemon.
- [ ] The result is recorded as the answer to V2 in section 13 of the spec, and the upgrade steps in section 11 are confirmed or corrected.

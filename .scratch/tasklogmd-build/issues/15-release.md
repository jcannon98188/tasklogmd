# 15: Release (HITL)

**What to build:** TaskLog can be installed and upgraded by a real user on Windows: the bundled package published to npm, with the upgrade path working. Spec reference: `.scratch/tasklogmd/spec.md`, sections 11 and 13 (V3). Needs a human for a clean-machine install and for the npm publish.

**Blocked by:** 03 Spike: upgrade with a running daemon; 14 Tracker doc and setup skill

**Status:** ready-for-agent

- [ ] Given the build, when inspected, then there is one ESM file per entry point and no native addon in the daemon.
- [ ] Given `engines` Node `>=24`, when installed on an older Node, then `tasklog doctor` reports the Node version check as failed with a fix.
- [ ] Given the published package, when installed globally on a clean Windows machine, then `tasklog --version` and `tasklog doctor` pass.
- [ ] Given a running daemon, when a newer version is installed with `npm i -g`, then the newer shim restarts it and no lazy-load error occurs, matching what the upgrade spike found.
- [ ] Given a fresh npm install, when run, then whether SmartScreen warns is recorded as the answer to V3 in the spec.
- [ ] The README documents install, registration, `tasklog stop` before upgrading, and `tasklog import`.

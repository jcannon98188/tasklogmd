# 15: Release (HITL)

**What to build:** TaskLog can be installed and upgraded by a real user on Windows: the bundled package published to npm, with the upgrade path working. Spec reference: `.scratch/tasklogmd/spec.md`, sections 11 and 13 (V3). Needs a human for a clean-machine install and for the npm publish.

**Blocked by:** 03 Spike: upgrade with a running daemon; 14 Tracker doc and setup skill

**Status:** ready-for-agent

- [x] Given the build, when inspected, then there is one ESM file per entry point and no native addon in the daemon.
- [x] Given `engines` Node `>=24`, when installed on an older Node, then `tasklog doctor` reports the Node version check as failed with a fix.
- [ ] Given the published package, when installed globally on a clean Windows machine, then `tasklog --version` and `tasklog doctor` pass.
- [ ] Given a running daemon, when a newer version is installed with `npm i -g`, then the newer shim restarts it and no lazy-load error occurs, matching what the upgrade spike found.
- [ ] Given a fresh npm install, when run, then whether SmartScreen warns is recorded as the answer to V3 in the spec.
- [x] The README documents install, registration, `tasklog stop` before upgrading, and `tasklog import`.

## Comments

Automated part done (branch `t3/tasklog-release-readiness`). Ticked: ACs 1, 2, 6. Left unticked (human-only): ACs 3, 4, 5.

- `package.json` was already publish-ready (`tasklog`, `engines` node `>=24`, `bin`, `files: ["dist"]`, MIT). Added `prepublishOnly` (`typecheck` + `build`). `npm pack --dry-run` lists exactly 4 files: `README.md`, `package.json`, `dist/cli.js`, `dist/daemon.js` (~644 kB packed).
- `src/doctor.ts`: `DoctorOptions.nodeVersion` seam (defaults to `process.versions.node`) so the Node-version check can be tested.
- `test/integration/release.test.ts`: manifest checks and no secrets; dist is exactly `cli.js` + `daemon.js`, ESM, no relative imports; no `.node`/`dlopen`/native-module requires and no `binding.gyp` in runtime deps; doctor fails `node-version` with a fix on Node 22 and passes on 24/26. It builds only when `dist` is missing, because a rebuild wipes `dist` and races the e2e tests (`npm test` builds first).
- README: install, registration, upgrade with `tasklog stop`, `tasklog import`, daemon cwd outside the package (spec section 11).
- Not run (by design): `npm publish`, `npm i -g` of the real package, any registration.

### Manual checklist (human)

- [ ] AC 3: on a clean Windows machine with Node 24+, run `npm i -g tasklog` (after publish). `tasklog --version` and `tasklog doctor` pass.
- [ ] AC 4: with a daemon running (`tasklog start`), publish or install a newer version via `npm i -g`. Confirm no `EBUSY`, the new shim restarts the daemon (protocol-mismatch path), and no lazy-load error appears in `daemon.log`. Repeat after `tasklog stop`.
- [ ] AC 5 (V3): on the fresh install, note whether SmartScreen warns when running `tasklog`. Record the answer under V3 in `.scratch/tasklogmd/spec.md`.
- [ ] Publish: `npm publish` from a clean checkout after `npm test` passes (`prepublishOnly` rebuilds).

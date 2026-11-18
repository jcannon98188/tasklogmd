# 15 – Windows packaging and distribution: facts

Researched 2026-11-17. Primary sources only (official docs). This note reports facts; it does **not** choose a route (the build spec does).

Context: a Node/TypeScript per-user daemon plus a stdio shim (MCP server for TaskLog.md, one daemon serving many workspaces). Note: `docs/adr/0001-daemon-behind-stdio-shim.md` does not exist on this branch; only `.scratch/tasklogmd/issues/07-daemon-architecture.md` was readable.

Routes compared: (A) npm global install / npx, (B) Node single executable application (SEA), (C) bundled installer (e.g. Inno Setup, MSI/MSIX).

---

## 1. How Claude Code launches the shim on Windows

Facts (all from Claude Code docs):

- Syntax: `claude mcp add [options] <name> -- <command> [args...]`. "For stdio servers, the `--` (double dash) separates Claude's own options, such as `--transport`, `--env`, and `--scope`, from the command and arguments that run the server." — <https://code.claude.com/docs/en/mcp> ("Add a local stdio server")
- Shell-independence: "`claude mcp add` works the same in every shell, including PowerShell and Command Prompt." — <https://code.claude.com/docs/en/mcp-quickstart>
- Official npx example: `claude mcp add playwright -- npx -y @playwright/mcp@latest` (quickstart, "Add a local server"). It requires Node 18+ there.
- **`cmd /c` wrapper: the MCP, MCP-quickstart and troubleshooting pages do not mention `cmd /c`, `cmd.exe` or `.cmd` shims at all** (keyword-scanned; not found). So the docs neither require nor document a `cmd /c npx` wrapper for MCP servers.
- The only documented Windows shim caveat is for **hooks**, not MCP: "On Windows, exec form requires `command` to resolve to a real executable such as a `.exe`. The `.cmd` and `.bat` shims that npm, npx, eslint, and other tools install in `node_modules/.bin` are not executables and can't be spawned without a shell. To run them in exec form, invoke the underlying script with `node` directly." — <https://code.claude.com/docs/en/hooks> ("Exec form and shell form"). Whether MCP stdio spawning has the same restriction is **not documented** (verify empirically; an unverified inference only).
- Startup timeout: default 30 s; "A stdio server's first run can be slow while `npx` downloads the package." Raise with `MCP_TIMEOUT` (ms). The quickstart notes the first check "can show `✘ Failed to connect` while `npx` downloads the package." — <https://code.claude.com/docs/en/mcp-quickstart> ("Connection timed out at startup")
- Config location on Windows: user/local scope servers live in `%USERPROFILE%\.claude.json` (or under `CLAUDE_CONFIG_DIR`); project scope in `.mcp.json` at the project root. — mcp-quickstart ("Find your configuration on disk"); mcp ("MCP installation scopes")
- Environment: the spawned server gets `CLAUDE_PROJECT_DIR` set to the project root; `roots/list` is answered with the launch directory plus `--add-dir` directories (and `notifications/roots/list_changed` on change). — mcp ("Add a local stdio server"). Useful for the shim to identify the workspace for the daemon.
- `.mcp.json` supports `${VAR}` and `${VAR:-default}` expansion in `command`, `args`, `env`, `url`, `headers`. — mcp ("Environment variable expansion in `.mcp.json`")
- Shutdown of the shim on Windows: "Claude Code closes the server's stdin, then ends the server's process tree if the process is still running 300 milliseconds later." (Before v2.1.296 it ended the tree immediately.) — mcp ("How Claude Code stops a stdio server"). Consequence stated by the docs: anything the shim spawns as a child is in that process tree; a daemon that must outlive the shim must be detached such that it is not in the tree (the docs do not say how Claude Code builds the tree on Windows, so detachment behaviour needs empirical testing).
- Restart behaviour: interactive session — an exited stdio server is marked failed and needs Reconnect in `/mcp`; in `claude -p`/SDK it is started again on the next tool call. Automatic reconnect applies to remote servers, not stdio. — mcp ("Stdio servers that exit or fail to start")
- Per-route launch command shapes (derived from the above, not stated by the docs):
  - A: `claude mcp add tasklog -- npx -y <pkg>` (npx path; first run downloads) or, after `npm i -g`, `claude mcp add tasklog -- <bin-name>` (resolves to a `.cmd` shim, see §2).
  - B: `claude mcp add tasklog -- C:\path\tasklog.exe` (a real `.exe`).
  - C: same as B with the installed path (or a PATH entry the installer adds).

## 2. npm route facts

- Default global prefix on Windows: `%AppData%\npm`; "Global installs on Windows go to `{prefix}/node_modules` (that is, no `lib` folder.)"; executables "directly into `{prefix}` on Windows". — <https://docs.npmjs.com/cli/v11/configuring-npm/folders>
- `bin` entries on Windows: "a cmd (Windows Command File) will be created which executes the specified file in the `bin` field, so it is available to run by `name` or `name.cmd` (on Windows PowerShell)", e.g. `C:\Users\{Username}\AppData\Roaming\npm\myapp.cmd`. A `.ps1` shim is not mentioned on that page. — <https://docs.npmjs.com/cli/v11/configuring-npm/package-json> (`bin`); `bin-links` doc: "symlinks (or `.cmd` shims on Windows)" — <https://docs.npmjs.com/cli/v11/commands/npm-install>
- npm cache on Windows: `%LocalAppData%\npm-cache`. — <https://docs.npmjs.com/cli/v11/commands/npm-cache>. npx: "The requested packages are installed to a folder in the npm cache." The literal `_npx` directory name is **not documented** on the pages read. — <https://docs.npmjs.com/cli/v11/commands/npm-exec>
- Staleness: `--prefer-online` "Forces staleness checks for packages"; `--prefer-offline`/`--offline` available; the default reuse-vs-refetch rule for npx is **not stated** on the page.
- `engines`: "Unless the user has set the engine-strict config flag, this field is advisory only" (warnings only, and only when installed as a dependency). — package-json docs. So `engines.node` does not enforce a Node floor by default; the daemon would need its own runtime check.
- Replacement semantics of `npm install -g` over an existing install, and behaviour when files are locked: **not documented** on the pages read. `npm update -g` updates globals to `latest`. — <https://docs.npmjs.com/cli/v11/commands/npm-update>
- Node installer PATH ordering can make `npm` resolve to the wrong copy (Program Files before `%AppData%\npm`) — <https://docs.npmjs.com/try-the-latest-stable-version-of-npm/>.
- Requires the user to already have Node + npm.

## 3. Node SEA route facts (Node v26.13.1 docs)

Source: <https://nodejs.org/api/single-executable-applications.html>

- Stability: "Stability: 1.1 - Active development". Added v19.7.0/v18.16.0; built-in `node --build-sea sea-config.json` added v25.5.0 (previously postject-based manual flow, still documented).
- Windows flow: config `{ "main": "hello.js", "output": "sea.exe" }` — "The `.exe` extension is necessary." Optional signing: `signtool sign /fd SHA256 sea.exe`; "A certificate needs to be present for this to work. However, the unsigned binary would still be runnable." Manual flow: copy `node.exe`, optionally `signtool remove /s`, inject blob `NODE_SEA_BLOB` with postject and the sentinel fuse.
- Embeds a single script: "supports running a single embedded script using the CommonJS or the ECMAScript Modules module system" (`mainFormat`: `commonjs` default, or `module`). Docs recommend bundling into one file first.
- Limitations: loading a module found only on the file system throws (workaround `createRequire(__filename)`); injected `require()` has only `require.main`; `import.meta.resolve` unsupported; native addons must be shipped as an asset, written to a file and loaded via `process.dlopen()`; `process.argv` user arguments start at index 2.
- Assets via `node:sea` (`getAsset`, `getAssetAsBlob`, `getRawAsset`, `getAssetKeys`). `useCodeCache` and `useSnapshot` supported since v20.6.0 (must be false when cross-building).
- CI platforms: Windows, macOS (arm64 only), Linux.
- The exe embeds the whole Node runtime (size not stated in the docs read).
- Because it is a real `.exe`, Claude Code can launch it with no wrapper (see §1 hooks note, which concerns shims only; MCP behaviour for `.exe` is the plain-command case).

## 4. Installer route facts

- Inno Setup (<https://jrsoftware.org/ishelp/>): `PrivilegesRequired` is `admin` (default) or `lowest`; "When set to lowest, Setup will not request to be run with administrative privileges" and "will always run in non administrative install mode"; in that mode the "auto" form of the directory and Shell Folder constants "is mapped to the 'user' form" (topic_setup_privilegesrequired.htm, topic_admininstallmode.htm). Exact default per-user install path was not verified.
- `CloseApplications` (default `yes`): "Setup uses Windows Restart Manager to detect, close, and restart applications"; if set to yes/force and running silently, "Setup will always close and restart such applications". `RestartApplications` (default `yes`) restarts them only if the app uses the `RegisterApplicationRestart` API. — topic_setup_closeapplications.htm, topic_setup_restartapplications.htm
- Signing support: `SignTool` directive signs Setup and the uninstaller; "When Setup has a valid digital signature, users will not see an 'unidentified program' warning when launching it." The docs say certificate acquisition is out of scope. — topic_setup_signtool.htm
- Windows Restart Manager: "enables all but the critical system services to be shut down and restarted", which "frees files that are in use and allows installation operations to complete"; Windows Installer 4.0 apps use it automatically. — <https://learn.microsoft.com/en-us/windows/win32/rstmgr/restart-manager-portal>, <https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/>
- MSIX/Store: a Store-distributed package is re-signed by Microsoft, so "users never see a SmartScreen warning". MSI/EXE installers submitted to the Store are not re-signed. — <https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options>
- The WiX/MSI toolchains were not researched.

## 5. Per-user data and logs

- Known folders (Microsoft Learn, <https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid>):
  - `FOLDERID_LocalAppData` {F1B32785-6FBA-4FCF-9D55-7B8E7F157091}, per-user, default `%LOCALAPPDATA%` (`%USERPROFILE%\AppData\Local`).
  - `FOLDERID_RoamingAppData` {3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}, per-user, default `%APPDATA%` (`%USERPROFILE%\AppData\Roaming`).
- Microsoft's Local Storage sample: LocalAppData is "commonly used by applications to store per-user persistent application data that's not included with an application installation" — <https://learn.microsoft.com/en-us/samples/microsoft/xbox-gdk-samples/localstorage/>. New code should use KNOWNFOLDERID, not CSIDL — <https://learn.microsoft.com/en-us/windows/win32/shell/csidl>.
- npm's own docs mention `%LOCALAPPDATA%\npm` as the alternative if roaming profiles are a concern (folders page), and put the npm cache in `%LocalAppData%\npm-cache`.
- Not found in official docs: an explicit "put logs here" rule or a Roaming-vs-Local data guideline beyond the folder definitions above (the page gives no prose definition of Local vs Roaming). The choice of `%LOCALAPPDATA%\TaskLog` vs Roaming is therefore a design decision, not a documented requirement. A local IPC endpoint/port file and per-machine state are naturally machine-specific (inference).
- Packaged (MSIX/UWP) apps get redirected LocalAppData; the Microsoft Q&A answer cited for this is community, not official, so not relied on.

## 6. Node version to require (as of 2026-11-17)

Sources: <https://nodejs.org/en/about/previous-releases> and the Release WG schedule <https://github.com/nodejs/Release> (`schedule.json`).

| Line | Codename | LTS start | Maintenance start | End of life |
|---|---|---|---|---|
| v22 | Jod | 2024-10-29 | 2025-10-21 | 2027-04-30 |
| v24 | Krypton | 2025-10-28 | 2026-10-20 | 2028-04-30 |
| v26 | Lithium | 2026-10-28 | 2027-10-20 | 2029-04-30 |
| v27 | – | 2027-10-20 | – | 2030-04-30 (alpha since 2026-10-28) |

- Status table on the releases page: v26 LTS (latest v26.13.1), v24 LTS, v22 LTS; v25 and below EOL; v27 Alpha. v26 is the Active LTS; v24 and v22 are Maintenance LTS.
- Policy: "Production applications should only use Active LTS or Maintenance LTS releases." LTS "typically guarantees that critical bugs will be fixed for a total of 30 months." From Node 27 the cycle becomes annual.
- SEA-relevant: built-in `--build-sea` is available from v25.5.0, so on an LTS line only v26 has it; `getAssetKeys` is in v24.8.0 and v22.20.0+.
- Claude Code's quickstart cites Node 18+ for npx-based servers (<https://code.claude.com/docs/en/mcp-quickstart>), which is now EOL.

## 7. Upgrading while the daemon runs (Windows file locking)

Documented facts (Microsoft Learn):

- `DeleteFile` "fails if an application attempts to delete a file that has other handles open for normal I/O or as a memory-mapped file (FILE_SHARE_DELETE must have been specified when other handles were opened)." — <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew>
- `CreateFile` `FILE_SHARE_DELETE`: "Enables subsequent open operations on a file or device to request delete access... Delete access allows both delete and rename operations." — <https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew>
- `MoveFile`: "The new name must not already exist"; it says nothing about open files or running images. `ReplaceFile` opens the replaced file with `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE` and fails with `ERROR_UNABLE_TO_REMOVE_REPLACED` if it cannot delete it. — <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefilew>, <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew>
- `MoveFileEx` with `MOVEFILE_DELAY_UNTIL_REBOOT`: not moved "until the operating system is restarted"; requires administrators group or LocalSystem; recorded in `HKLM\...\PendingFileRenameOperations`. — <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw>. Hence unusable for a non-admin per-user upgrade.
- Restart Manager can shut down and restart the applications holding files in use (see §4).
- **Not found in official docs:** an explicit statement that a running `.exe`/`.dll` (image section) cannot be overwritten or deleted, or whether it can be renamed. The DeleteFile "memory-mapped file" sentence is the closest. Treat "the running exe/DLL is locked against overwrite/delete" as unverified-by-doc and test it.

Per-route implications of the documented behaviour:

- A (npm): the daemon runs `node` (from the Node install) with JS files under the global prefix `node_modules`; Node loads JS source and does not keep it open, but native addons (`.node`) are loaded as DLLs (inference — memory-mapped, so DeleteFile rule applies). npm's docs do not describe lock handling, so an upgrade replacing a package with a loaded native addon is unspecified. Pure-JS install avoids that.
- B (SEA): the daemon *is* the `.exe`, so its image is mapped while running; the documented DeleteFile rule makes replacing it in place risky; a stop-then-replace or side-by-side versioned directory plus a launcher are the patterns the docs' primitives allow (design, not a doc statement).
- C (installer): Restart Manager integration is built into Inno Setup (`CloseApplications`) and Windows Installer, which closes holders before replacing files; it can restart them only if they registered via `RegisterApplicationRestart`.
- Claude Code itself closes the shim's stdin and then kills its tree within 300 ms on Windows (§1), so the shim is short-lived per session while the daemon would persist, and the daemon needs its own upgrade/shutdown protocol.

## 8. Code signing and SmartScreen

Sources: <https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation>, <https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options>, <https://learn.microsoft.com/en-us/azure/artifact-signing/faq>

- Unsigned: "When a file is not signed, SmartScreen reputation must build for each new version of your files"; unsigned files give the "Windows protected your PC" warning with "Run anyway".
- Signed: "Even when signed, a newly created binary could still show a SmartScreen warning" until its hash or publisher certificate accumulates reputation. "There is no exact threshold, but it can take several weeks and hundreds of clean installs from a wide audience." Reputation "cannot transfer from previous versions unless both were signed using the same publisher identity."
- EV: "EV certificates no longer bypass SmartScreen"; "That behavior was removed in 2024"; EV is "no longer justified" solely to avoid warnings.
- Azure Artifact Signing (formerly Trusted Signing): "Microsoft's recommended code signing service for developers who distribute apps outside the Store"; "does not provide instant SmartScreen trust" but publisher reputation builds over time. About $9.99/month. Eligibility: orgs in USA, Canada, EU, UK; individuals USA and Canada only; identity validation (a few business days); no free/trial subscriptions; no custom CN/O. "You can sign all file types that SignTool supports." Not Store-eligible; no EV certificates, none planned.
- Alternatives: OV cert roughly $150–300/year, EV $400+/year; for outside supported regions "use OV certificates instead". SignPath Foundation offers free OV-level signing for qualifying open source (code-signing-options).
- Store: Store-distributed apps "are signed by a Microsoft certificate and are never subject to SmartScreen download warnings"; Store MSIX signing is free.
- Smart App Control (Windows 11): "signature checks apply to all executable files, not just those downloaded from the Internet" (smartscreen-reputation).
- **Not found:** whether SmartScreen/Mark-of-the-Web applies to files installed by npm, or to JavaScript run by an already-trusted `node.exe`. The pages speak only of downloaded files and executables.

Per route (derived from the facts above): A runs the already-installed Node (Node's own signature) plus unsigned JS — no signing artifact the docs describe; B ships a new `.exe` whose reputation builds per version/publisher and benefits from signing (Node docs say signing is optional); C ships an installer `.exe`/MSI that Inno's `SignTool` can sign, plus the installed binaries.

## 9. Summary matrix (facts only)

| Concern | A: npm / npx | B: Node SEA | C: Installer |
|---|---|---|---|
| Needs Node preinstalled | Yes (user's Node; `engines` advisory only) | No (runtime embedded) | No if it bundles SEA/Node; yes otherwise |
| Launch from `claude mcp add` | `npx -y pkg` or global `.cmd` shim; `cmd /c` not documented either way; first npx run can exceed 30 s timeout | Plain `.exe` path | Plain `.exe` path or PATH entry |
| Per-user, no admin | Yes (`%AppData%\npm`) | Yes if placed in user dir | Yes with Inno `PrivilegesRequired=lowest` |
| Upgrade vs running daemon | npm docs silent; JS not locked, native addons are | Running image; DeleteFile rule risky | Restart Manager closes/restarts apps |
| SmartScreen/signing | Nothing downloaded as an exe | Signing optional per Node docs; reputation per version | Installer signable with `SignTool` |
| Maturity | Stable | "Active development" (1.1) | Stable |

## Gaps to verify empirically

1. Does Claude Code on Windows launch a bare `npx` / global `.cmd` shim as an MCP stdio command without `cmd /c`? (Docs silent; hooks docs say shims cannot be spawned without a shell in exec form.)
2. Can a running Node SEA `.exe` be renamed/replaced on Windows (docs silent on image sections)?
3. Does Claude Code's Windows "end the process tree" kill a daemon started by the shim, and what detachment survives it?
4. WiX/MSI behaviours, default Inno per-user path, and npm's `_npx` cache/reuse rules were not covered by primary sources read.
5. `docs/adr/0001-daemon-behind-stdio-shim.md` is absent from this branch.

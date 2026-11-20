# TaskLog.md Glossary

**TaskLog**:
A markdown-based task board, backed by a daemon, that treats markdown files as the source of truth.

**Daemon**:
The single per-user background process that serves every registered workspace.

**Shim**:
The small process an MCP client launches to talk to TaskLog. It connects the client to the daemon, starting the daemon first if it is not running.

**Workspace**:
A repo directory registered with the daemon. Its files are watched and indexed.

**Model**:
The daemon's in-memory index of a workspace. It is derived from the files and can always be rebuilt from them.

**Native format**:
TaskLog's own file format for maps, specs and tickets. It is the only format the daemon watches and writes.

**Item**:
Any file in the native format. Every item has a kind: map, spec, ticket, container or component. Only maps, specs and tickets belong to an effort.

**Effort**:
A body of work with one map, one spec and many tickets. It is the unit that groups items and the namespace for their IDs.

**Item ID**:
The permanent identifier of an item, made of its effort and a number (or `map` or `spec`). It never changes, even when the title does.

**Acceptance criterion (AC)**:
One checkable condition on a ticket. It has a number that is stable within its ticket and never reused.

**Status**:
Where an item stands: open, claimed, resolved or closed. Closed means ruled out without being resolved.

**Claim**:
A session's marker on an open ticket saying it is working on it. It records who holds it and moves the ticket to claimed.

**Stale claim**:
A claim that has not been touched for longer than a threshold, so its holder has probably gone. It is surfaced, never expired automatically.

**Frontier**:
The open tickets of an effort whose blockers are all resolved or closed. These are the tickets that can be taken now.

**Overview**:
A read-only summary of an effort: what is done, in progress, ready, blocked and still to do.

**Backlog layout**:
The file layout used by backlog.md. It is an import source only.

**Scratch layout**:
The local-markdown layout used by the wayfinder and implement-spec skills (`.scratch/<effort>/map.md` and `issues/NN-<slug>.md`). It is an import source only.

**Import**:
A one-shot conversion of a backlog layout or scratch layout tree into the native format. The originals are left untouched.

**Fine-grained edit**:
A change to one part of a task, such as toggling or rewording a single acceptance criterion, applied to the file as a minimal diff.

**Tag**:
A searchable label on a task. It is a TaskLog addition that works in both layouts.

**Architecture**:
The picture of what a workspace's codebase is made of, kept as elements. It is separate from every effort, and "map" never refers to it.

**Element**:
An item that describes one container or component of the architecture. It names the code it owns, which elements it uses and whether anyone has confirmed it.

**Container**:
A runnable or deployable unit of the codebase, such as the daemon, the shim or the CLI.

**Component**:
A part inside a container, or inside another component.

**Owned code**:
The repo paths an element claims as its own. A scan may rewrite them; it never changes anything else about the element.

**Owner**:
The element that owns a given file: the one whose owned code has the longest matching root. A component's root beats its container's.

**Review**:
Whether an element has been confirmed. Proposed means a scan found it and no one has checked it; accepted means a person or agent confirmed it. It is not a status.

**Scan**:
A pass over the repo's structure that proposes elements and refreshes the owned code of existing ones. Existing elements are matched by owned code, never by name.

**Drift**:
A mismatch between the architecture and the code: an element owns a path that no longer exists, or a part of the repo belongs to no element. It is reported, never fixed automatically.

**Touched component**:
An element that a ticket says it affects. The ticket owns this link.

**Hotspot**:
An element that many tickets link to. It is a prompt to look closer, not a verdict that something is wrong.

**Build spec**:
The destination of this effort: a document detailed enough to be turned into implementation tickets.

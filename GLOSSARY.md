# TaskLog.md Glossary

**TaskLog**:
A markdown-based task board, backed by a daemon, that treats markdown files as the source of truth.

**Daemon**:
The single per-user background process that serves every registered workspace.

**Workspace**:
A repo directory registered with the daemon. Its files are watched and indexed.

**Model**:
The daemon's in-memory index of a workspace. It is derived from the files and can always be rebuilt from them.

**Native format**:
TaskLog's own file format for maps, specs and tickets. It is the only format the daemon watches and writes.

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

**Build spec**:
The destination of this effort: a document detailed enough to be turned into implementation tickets.

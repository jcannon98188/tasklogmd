Type: research
Status: open
Blocked by:

## Question

What is the most reliable way to watch a tree of markdown files from Node on Windows? Compare `fs.watch`, chokidar and @parcel/watcher on event reliability, atomic-save handling (editors that write a temp file and rename), event coalescing, startup scan cost, and ways to ignore the daemon's own writes (content hash or write token). Use primary sources: Node docs and each library's repo and issue tracker.

Type: grilling
Status: resolved
Blocked by: 11, 12, 13, 14, 15

## Question

Decide the shape and structure of the final build spec at `.scratch/tasklogmd/spec.md` and write it. Cover the section outline, how the decisions so far (and their amendments) are consolidated without restating them inconsistently, how the Windows packaging choice is made from the research, the implementation spikes (Windows process detach and tree kill) and their order, the ticket-sized build slices that `/to-tickets` and `/implement-spec` will cut, and the acceptance criteria style for each slice. This is the destination ticket: when it resolves, the map is done.

## Answer

Settled by grilling with the user (all six recommendations accepted). The spec is written at `.scratch/tasklogmd/spec.md`. No new glossary terms.

- **Structure:** one file, 14 sections plus two appendices: overview, architecture, native format, model and write protocol, MCP tool surface, search, errors and logging, CLI, import, tracker doc and setup, packaging, testing, spikes, build slices; Appendix A lists amendments, Appendix B holds the tracker doc template. Each decision is stated once in its home section and names its source ticket; amendments appear only as the final rule plus a line in Appendix A.
- **Packaging choice:** npm global install, `engines` Node `>=24`, registered with `claude mcp add --scope user tasklog -- tasklog shim` (or `cmd /c tasklog shim` if Spike 2 requires it). The single executable and the installer are out of v1. The package is bundled to one ESM file per entry point and the daemon has no native addons, so an upgrade never replaces a file a running daemon still needs.
- **Spikes:** three throwaway spikes run first: detach and tree kill (gates everything, five-point bar, fallbacks `cmd /c start` then a scheduled task), launch from Claude Code, and upgrade with a running daemon. Three open verification items (V1 to V3) are tied to the spike or release test that settles each.
- **Slices:** 13 vertical slices: spikes, walking skeleton, parser and read tools, minimal-diff editor and write protocol, watcher, creation and numbering, workflow tools, search, error table and observability, full CLI, import, tracker doc and setup, release. Slices 1, 12 and 13 are HITL; the rest are AFK.
- **AC style:** numbered `- [ ] #N` given/when/then criteria, each ending with the layer that proves it (`[unit]`, `[integration]`, `[e2e]`, `[manual]`).

// Workflow operations (spec section 5): claim, release, resolve, close, add_decision, add_out_of_scope and
// triage, composed from `WriteService.edit` with the internal `set_state` edit. Status, `claimed_by` and
// `updated` can only change here, so the `## Answer` side effect cannot be skipped. `frontier` and
// `overview` are pure reads in `model/workflow.ts`.

import { TaskLogError, isTaskLogError } from '../errors.ts';
import type { Logger } from '../log.ts';
import type { Edit } from '../model/edit.ts';
import type { ItemView } from '../model/index.ts';
import { sectionText } from '../model/workflow.ts';
import type { ModelManager } from './models.ts';
import type { WriteService } from './writes.ts';

export const TRIAGE_STATES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'] as const;
export const TRIAGE_CATEGORIES = ['bug', 'enhancement'] as const;

export type StepResult = 'ok' | 'skipped' | 'failed';

export interface StepReport {
  ticket: StepResult;
  map: StepResult;
  /** Why a step was skipped or failed. */
  notes?: Record<string, string>;
}

const bad = (message: string, details?: Record<string, unknown>): TaskLogError => new TaskLogError('bad_request', { message, details });

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

function nonEmpty(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw bad(`${what} is required and must not be empty.`);
  return value;
}

export class WorkflowService {
  constructor(
    private readonly models: ModelManager,
    private readonly writes: WriteService,
    private readonly log: Logger,
  ) {}

  /** Current time as an ISO timestamp, written to `updated` by every status change. */
  private stamp(): string {
    return new Date(this.writes.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /**
   * Runs `build` against the model's view of `id` and writes the edit it returns. Without a caller `hash`
   * the model's hash is used and a `stale_hash` (someone wrote in between) re-evaluates the preconditions
   * against the refreshed model; with one, a stale hash is the caller's to handle. `build` returns null for
   * "nothing to do". Returns the item's hash after the call.
   */
  private async mutate(
    root: string,
    id: string,
    hash: string | undefined,
    build: (view: ItemView) => Edit | null,
  ): Promise<{ hash: string; changed: boolean }> {
    for (let attempt = 0; ; attempt++) {
      const idx = await this.models.ready(root);
      const view = idx.get(id);
      const edit = build(view);
      if (!edit) return { hash: view.hash, changed: false };
      try {
        const r = await this.writes.edit(root, view.id, hash ?? view.hash, edit);
        return { hash: r.hash, changed: r.changed };
      } catch (e) {
        if (hash === undefined && isTaskLogError(e) && e.code === 'stale_hash' && attempt < 5) continue;
        throw e;
      }
    }
  }

  private async ticket(root: string, id: string): Promise<ItemView> {
    const view = (await this.models.ready(root)).get(id);
    if (view.parse.fields.kind !== 'ticket') throw bad(`${view.id} is a ${view.parse.fields.kind}, not a ticket; only tickets are claimed, resolved, closed and triaged.`, { id: view.id });
    return view;
  }

  // ---- claims ---------------------------------------------------------------------------------------------

  async claim(root: string, a: { id: string; claimant: string; hash?: string }): Promise<{ id: string; hash: string; changed: boolean }> {
    const claimant = oneLine(nonEmpty(a.claimant, 'claimant'));
    await this.ticket(root, a.id);
    const r = await this.mutate(root, a.id, a.hash, (view) => {
      const f = view.parse.fields;
      if (f.kind !== 'ticket') throw bad(`${view.id} is not a ticket.`);
      if (f.status === 'claimed') {
        if (f.claimedBy === claimant) return null;
        throw new TaskLogError('already_claimed', {
          message: `${view.id} is already claimed by ${f.claimedBy ?? 'someone else'}; pick another ticket, or ask them to release it.`,
          details: { id: view.id, claimed_by: f.claimedBy ?? null },
        });
      }
      if (f.status !== 'open') throw new TaskLogError('bad_transition', { message: `${view.id} is ${f.status}; only open tickets can be claimed.`, details: { id: view.id, status: f.status } });
      return { op: 'set_state', status: 'claimed', claimed_by: claimant, updated: this.stamp() };
    });
    return { id: a.id, ...r };
  }

  async release(root: string, a: { id: string; claimant?: string; hash?: string; force?: boolean }): Promise<{ id: string; hash: string; changed: boolean }> {
    const claimant = a.claimant === undefined ? undefined : oneLine(String(a.claimant));
    await this.ticket(root, a.id);
    const r = await this.mutate(root, a.id, a.hash, (view) => {
      const f = view.parse.fields;
      if (f.status === 'open') throw new TaskLogError('not_claimed', { message: `${view.id} is not claimed; nothing to release.`, details: { id: view.id } });
      if (f.status !== 'claimed') throw new TaskLogError('bad_transition', { message: `${view.id} is ${f.status}; only a claimed ticket can be released.`, details: { id: view.id, status: f.status } });
      if (!a.force && f.claimedBy !== undefined && f.claimedBy !== claimant) {
        throw new TaskLogError('already_claimed', {
          message: `${view.id} is claimed by ${f.claimedBy}, not ${claimant ?? 'you'}; pass force: true to release someone else's claim.`,
          details: { id: view.id, claimed_by: f.claimedBy },
        });
      }
      return { op: 'set_state', status: 'open', claimed_by: null, updated: this.stamp() };
    });
    return { id: a.id, ...r };
  }

  // ---- resolve and close ----------------------------------------------------------------------------------

  /**
   * Writes the ticket (Answer, status, claimed_by, updated in one edit), then the map line. A ticket that is
   * already in the target state with the same Answer skips the first step, so a retry after a failed map
   * append only does the map step. The map append is idempotent on its link target.
   */
  private async finish(
    root: string,
    a: { id: string; hash?: string },
    kind: { status: 'resolved' | 'closed'; text: string; mapHeading: string; mapGist?: string },
  ): Promise<{ id: string; hash: string; steps: StepReport }> {
    const answer = nonEmpty(kind.text, kind.status === 'resolved' ? 'answer' : 'reason').replace(/\r\n?/g, '\n').trim();
    let target = '';
    let title = '';
    const steps: StepReport = { ticket: 'ok', map: 'skipped' };
    const ticketRes = await this.mutate(root, a.id, a.hash, (view) => {
      const f = view.parse.fields;
      if (f.kind !== 'ticket') throw bad(`${view.id} is not a ticket.`);
      steps.ticket = 'ok';
      title = f.title;
      target = view.path.split("/").slice(2).join("/");
      if (f.status === kind.status) {
        if ((sectionText(view.parse, 'Answer') ?? '') === answer) {
          steps.ticket = 'skipped';
          return null;
        }
        throw new TaskLogError('bad_transition', { message: `${view.id} is already ${f.status} with a different Answer; use set_fields reopen: true first to change it.`, details: { id: view.id, status: f.status } });
      }
      if (f.status !== 'open' && f.status !== 'claimed') {
        throw new TaskLogError('bad_transition', { message: `${view.id} is ${f.status}; only open or claimed tickets can be ${kind.status}.`, details: { id: view.id, status: f.status } });
      }
      return { op: 'set_state', answer, status: kind.status, claimed_by: null, updated: this.stamp() };
    });

    if (kind.mapGist === undefined) return { id: a.id, hash: ticketRes.hash, steps };
    const gist = oneLine(kind.mapGist);
    if (gist === '') throw bad('The gist must not be empty.');
    const effort = a.id.split('/')[0]!;
    try {
      const r = await this.appendMapLine(root, effort, kind.mapHeading, `- [${oneLine(title)}](${target}): ${gist}`, target);
      steps.map = r.changed ? 'ok' : 'skipped';
      if (!r.changed) steps.notes = { map: 'already present' };
    } catch (e) {
      if (isTaskLogError(e) && e.code === 'not_found') {
        steps.map = 'skipped';
        steps.notes = { map: `no map for effort ${effort}` };
      } else {
        steps.map = 'failed';
        throw new TaskLogError('partial', {
          message: `${a.id} was written but the ${kind.mapHeading} line was not (${(e as Error).message}); retry the same call to finish it.`,
          details: { id: a.id, hash: ticketRes.hash, steps, error: isTaskLogError(e) ? e.toJSON() : { message: (e as Error).message } },
        });
      }
    }
    return { id: a.id, hash: ticketRes.hash, steps };
  }

  resolve(root: string, a: { id: string; answer: string; gist?: string; hash?: string }) {
    return this.finish(root, a, { status: 'resolved', text: a.answer, mapHeading: 'Decisions so far', mapGist: a.gist });
  }

  close(root: string, a: { id: string; reason: string; out_of_scope_gist?: string; hash?: string }) {
    return this.finish(root, a, { status: 'closed', text: a.reason, mapHeading: 'Out of scope', mapGist: a.out_of_scope_gist });
  }

  // ---- map lines ------------------------------------------------------------------------------------------

  /**
   * Appends one line to a section of the effort's map unless a line with the same link target (or, for a line
   * without a link, the same text) is already there. Retries on a concurrent write to the map.
   */
  private async appendMapLine(root: string, effort: string, heading: string, line: string, target?: string): Promise<{ hash: string; changed: boolean }> {
    const key = target ?? /\]\(([^)\s]+)\)/.exec(line)?.[1];
    return this.mutate(root, `${effort}/map`, undefined, (view) => {
      if (view.parse.fields.kind !== 'map') throw bad(`${view.id} is not a map.`);
      const existing = sectionText(view.parse, heading) ?? '';
      const present = key !== undefined ? existing.includes(`](${key})`) : existing.split('\n').some((l) => l.trim() === line.trim());
      return present ? null : { op: 'append_to_section', heading, content: line };
    });
  }

  private async mapLine(root: string, heading: string, a: { effort: string; title_link: string; gist: string }): Promise<{ hash: string; changed: boolean }> {
    const effort = nonEmpty(a.effort, 'effort').trim();
    const link = oneLine(nonEmpty(a.title_link, 'title_link'));
    const gist = oneLine(nonEmpty(a.gist, 'gist'));
    return this.appendMapLine(root, effort, heading, `- ${link}: ${gist}`);
  }

  addDecision(root: string, a: { effort: string; title_link: string; gist: string }) {
    return this.mapLine(root, 'Decisions so far', a);
  }

  addOutOfScope(root: string, a: { effort: string; title_link: string; gist: string }) {
    return this.mapLine(root, 'Out of scope', a);
  }

  // ---- triage ---------------------------------------------------------------------------------------------

  /**
   * Keeps exactly one state tag (and one category tag when `category` is given) on a ticket, replacing the
   * old ones. `wontfix` also closes the ticket with `note` (or a default) as the Answer; for the other
   * states `note` is appended to `## Comments`.
   */
  async triage(
    root: string,
    a: { id: string; state: string; category?: string; note?: string; hash?: string },
  ): Promise<{ id: string; hash: string; changed: boolean }> {
    if (!(TRIAGE_STATES as readonly string[]).includes(a.state)) throw bad(`state must be one of ${TRIAGE_STATES.join(', ')}; got ${JSON.stringify(a.state)}.`);
    if (a.category !== undefined && !(TRIAGE_CATEGORIES as readonly string[]).includes(a.category)) throw bad(`category must be one of ${TRIAGE_CATEGORIES.join(', ')}; got ${JSON.stringify(a.category)}.`);
    const note = a.note === undefined || a.note.trim() === '' ? undefined : a.note.replace(/\r\n?/g, '\n').trim();
    const wontfix = a.state === 'wontfix';
    await this.ticket(root, a.id);
    const r = await this.mutate(root, a.id, a.hash, (view) => {
      const f = view.parse.fields;
      if (wontfix && (f.status === 'resolved')) throw new TaskLogError('bad_transition', { message: `${view.id} is resolved; it cannot be closed as wontfix.`, details: { id: view.id, status: f.status } });
      const keep = f.tags.filter((t) => !(TRIAGE_STATES as readonly string[]).includes(t) && !(a.category !== undefined && (TRIAGE_CATEGORIES as readonly string[]).includes(t)));
      const tags = [...keep, a.state, ...(a.category !== undefined ? [a.category] : [])];
      const edit: Extract<Edit, { op: 'set_state' }> = { op: 'set_state', tags };
      if (wontfix && f.status !== 'closed') {
        edit.answer = note ?? 'Closed as wontfix.';
        edit.status = 'closed';
        edit.claimed_by = null;
        edit.updated = this.stamp();
      }
      return edit;
    });
    let hash = r.hash;
    let changed = r.changed;
    if (note !== undefined && !wontfix) {
      try {
        const n = await this.mutate(root, a.id, undefined, (view) => ((sectionText(view.parse, 'Comments') ?? '').includes(note) ? null : { op: 'append_to_section', heading: 'Comments', content: note }));
        hash = n.hash;
        changed = changed || n.changed;
      } catch (e) {
        throw new TaskLogError('partial', {
          message: `The tags of ${a.id} were updated but the note was not appended (${(e as Error).message}); retry the same call to finish it.`,
          details: { id: a.id, hash, steps: { tags: 'ok', note: 'failed' } },
        });
      }
    }
    return { id: a.id, hash, changed };
  }
}

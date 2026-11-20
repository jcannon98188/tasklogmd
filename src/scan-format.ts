import type { ScanResult } from './daemon/architecture-scan.ts';

const MAX_PER_GROUP = 20;

/** Human output of `tasklog scan`: counts, changes, findings by category, ignored counts, then at most one next-step line. */
export function formatScan(r: ScanResult, proposed: number): string {
  const lines: string[] = [];
  lines.push(`${r.dry_run ? 'Scan (dry run)' : 'Scan complete'}: ${r.created.length} created, ${r.updated.length} updated, ${r.unchanged} unchanged, ${r.skipped.length} skipped.`);
  for (const c of r.created) lines.push(`  created ${c.id} (${c.kind}${c.parent ? ` in ${c.parent}` : ''}): ${c.code.join(', ') || '(no code)'}`);
  for (const u of r.updated) {
    const parts = [...u.added.map((p) => `+${p}`), ...u.removed.map((p) => `-${p}`)];
    lines.push(`  updated ${u.id}: ${parts.join(' ')}`);
  }
  for (const s of r.skipped) lines.push(`  skipped ${s.id}: ${s.reason}`);

  const groups = new Map<string, ScanResult['findings']>();
  for (const f of r.findings) groups.set(f.category, [...(groups.get(f.category) ?? []), f]);
  if (groups.size > 0) lines.push('', `Findings (${r.findings.length}):`);
  for (const [cat, items] of groups) {
    lines.push(`  ${cat} (${items.length})`);
    for (const f of items.slice(0, MAX_PER_GROUP)) lines.push(`    ${[f.id, f.path].filter(Boolean).join(' ')}${f.id || f.path ? ': ' : ''}${f.detail}`);
    if (items.length > MAX_PER_GROUP) lines.push(`    ... and ${items.length - MAX_PER_GROUP} more (use --json for all)`);
  }

  const ign = Object.entries(r.ignored).filter(([, v]) => v.count > 0);
  if (ign.length > 0) lines.push('', `Ignored: ${ign.map(([k, v]) => `${k} ${v.count}`).join(', ')}`);

  if (proposed > 0) {
    lines.push('', `${proposed} proposed elements need curation. Ask your agent to curate the Architecture, or see docs/agents/issue-tracker.md#architecture.`);
  }
  if (r.dry_run) lines.push('', 'Nothing written. Re-run without --dry-run to apply.');
  return lines.filter((l, i, a) => !(l === '' && (a[i - 1] === '' || i === 0))).join('\n');
}

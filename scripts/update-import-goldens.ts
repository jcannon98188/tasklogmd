// Regenerates the golden native trees for the import fixtures (test/fixtures/import/<name>.golden/.tasklog).
// Run `node scripts/update-import-goldens.ts` after an intentional change to the importer, then review the diff.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runImport } from '../src/import/import.ts';
import { copyImportFixture, IMPORT_FIXTURES } from '../test/import-helpers.ts';

for (const name of ['scratch', 'backlog'] as const) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasklog-golden-'));
  try {
    const ws = copyImportFixture(name, tmp);
    const report = runImport({ path: ws, cwd: tmp });
    const golden = path.join(IMPORT_FIXTURES, `${name}.golden`);
    fs.rmSync(golden, { recursive: true, force: true });
    fs.mkdirSync(golden, { recursive: true });
    fs.cpSync(path.join(ws, '.tasklog'), path.join(golden, '.tasklog'), { recursive: true });
    console.log(`${name}: ${report.imported.length} imported, ${report.skipped.length} skipped, ${report.warnings.length} warnings`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

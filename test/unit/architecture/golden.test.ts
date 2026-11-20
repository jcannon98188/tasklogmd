import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/architecture/detect.ts';
import { FIXTURE_NAMES, fixtureDir, loadFixture } from '../../architecture-fixtures.ts';

// Whole-output comparison against the checked-in scan.golden.json of each fixture. Update only with an
// explicit `UPDATE_GOLDEN=1 npm run test:unit` run and review the diff.
const UPDATE = process.env.UPDATE_GOLDEN === '1';

describe('detect goldens', () => {
  for (const name of FIXTURE_NAMES) {
    it(name, () => {
      const actual = `${JSON.stringify(detect(loadFixture(name).detectInput), null, 2)}\n`;
      const path = `${fixtureDir(name)}scan.golden.json`;
      if (UPDATE) writeFileSync(path, actual);
      expect(existsSync(path), `missing ${path}; run with UPDATE_GOLDEN=1`).toBe(true);
      expect(actual).toBe(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));
    });
  }

  it('is idempotent: detecting twice gives the same result', () => {
    for (const name of FIXTURE_NAMES) {
      const input = loadFixture(name).detectInput;
      expect(detect(input)).toEqual(detect(input));
    }
  });
});

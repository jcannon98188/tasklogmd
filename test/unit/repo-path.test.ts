import { describe, expect, it } from 'vitest';
import { normalizeRepoPath } from '../../src/model/repo-path.ts';

describe('normalizeRepoPath', () => {
  const ROOT_POSIX = '/home/me/ws';
  const ROOT_WIN = 'C:\\Users\\me\\ws';

  const rows: Array<[string, string, string | undefined, string | null]> = [
    ['plain relative path', 'src/daemon', undefined, 'src/daemon'],
    ['backslashes', 'src\\daemon\\writes.ts', undefined, 'src/daemon/writes.ts'],
    ['leading ./', './src/daemon', undefined, 'src/daemon'],
    ['trailing slash', 'src/daemon/', undefined, 'src/daemon'],
    ['doubled separators', 'src//daemon///writes.ts', undefined, 'src/daemon/writes.ts'],
    ['inner dot segments', 'src/./daemon', undefined, 'src/daemon'],
    ['inner .. stays inside', 'src/x/../daemon', undefined, 'src/daemon'],
    ['workspace root as dot', '.', undefined, '.'],
    ['workspace root as ./', './', undefined, '.'],
    ['case is preserved', 'Src/Daemon', undefined, 'Src/Daemon'],
    ['spaces inside segments survive', 'my dir/a b.ts', undefined, 'my dir/a b.ts'],
    ['escaping the workspace', '../outside', undefined, null],
    ['escaping after a descent', 'a/../../outside', undefined, null],
    ['empty input', '', undefined, null],
    ['blank input', '   ', undefined, null],
    ['absolute path without a root', '/home/me/ws/src', undefined, null],
    ['absolute path under a posix root', '/home/me/ws/src/daemon', ROOT_POSIX, 'src/daemon'],
    ['absolute path equal to the root', '/home/me/ws', ROOT_POSIX, '.'],
    ['absolute path outside the root', '/home/me/other/src', ROOT_POSIX, null],
    ['sibling sharing a prefix with the root', '/home/me/ws-two/src', ROOT_POSIX, null],
    ['posix root is case-sensitive', '/HOME/me/ws/src', ROOT_POSIX, null],
    ['drive-letter path under a drive-letter root', 'C:\\Users\\me\\ws\\src\\daemon', ROOT_WIN, 'src/daemon'],
    ['drive letter case differs', 'c:\\users\\ME\\ws\\src', ROOT_WIN, 'src'],
    ['drive-letter path outside the root', 'C:\\Users\\me\\elsewhere\\src', ROOT_WIN, null],
    ['remainder case is preserved under a drive-letter root', 'C:\\Users\\me\\ws\\Src\\Daemon', ROOT_WIN, 'Src/Daemon'],
  ];

  it.each(rows)('%s', (_name, input, root, expected) => {
    expect(normalizeRepoPath(input, root)).toBe(expected);
  });
});

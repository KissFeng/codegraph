import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

let dir: string;
let cg: CodeGraph;

const files: Record<string, string> = {
  'src/services.ts': `
export class WindowService {
  open(url: string): void {}
}

export class StorageService {
  getItem(key: string): string | null {
    return null;
  }
}

export class PageService {
  reload(): void {}
  back(): void {}
}
`,
  'src/browser.ts': `
import { WindowService } from './services';

export function openHelp(): void {
  window.open('/help');
}

export function readToken(): string | null {
  return localStorage.getItem('token');
}

export function refresh(): void {
  location.reload();
}

export function goBack(): void {
  history.back();
}

export function openViaService(svc: WindowService): void {
  svc.open('/dashboard');
}
`,
};

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-browser-globals-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
});

afterAll(() => {
  cg.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

const node = (name: string, file: string) =>
  cg.getNodesByName(name).find((n) => n.filePath.endsWith(file) && (n.kind === 'function' || n.kind === 'method'))!;
const callersOf = (name: string, file: string) =>
  cg.getCallers(node(name, file).id)
    .filter(({ edge }) => edge.kind === 'calls')
    .map(({ node: n }) => n.name)
    .sort();

describe('browser global calls (#2907)', () => {
  it('calls on browser globals (window.open, localStorage.getItem, location.reload, history.back) do not link to same-named project methods', () => {
    expect(callersOf('open', 'services.ts')).toEqual(['openViaService']);
    expect(callersOf('getItem', 'services.ts')).toEqual([]);
    expect(callersOf('reload', 'services.ts')).toEqual([]);
    expect(callersOf('back', 'services.ts')).toEqual([]);
  });
});

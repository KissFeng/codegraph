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
  close(): void {}
}

export class StorageService {
  getItem(key: string): string | null {
    return null;
  }
  setItem(key: string, value: string): void {}
}

export class PageService {
  reload(): void {}
  back(): void {}
}
`,
  'src/router.ts': `
export class Router {
  back(): void {}
  reload(): void {}
  forward(): void {}
}

export function getRouter(): Router {
  return new Router();
}

export function createRouter(): Router {
  return new Router();
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

export function readTokenChained(): string | null {
  return window.localStorage.getItem('token');
}

export function setTokenChained(): void {
  window.sessionStorage.setItem('a', 'b');
}

export function goBackChained(): void {
  window.history.back();
}

export function refreshChained(): void {
  window.location.reload();
}

export function closeSelf(): void {
  self.close();
}
`,
  'src/router-usage.ts': `
import { Router, getRouter, createRouter } from './router';

export function t7(): void {
  const r: Router = getRouter();
  r.back();
  r.reload();
}

export function f4(): void {
  const history = createRouter();
  history.forward();
}
`,
  'src/same-file-fn.ts': `
function performance() {
  return 1;
}
function screen() {}
function location() {}

export function m1(): void {
  performance();
  screen();
  location();
}
`,
  'src/param-global.js': `
export class Location {
  distanceTo(o) {
    return 0;
  }
}

export function near(location, other) {
  return location.distanceTo(other);
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
const callersOfMethod = (className: string, methodName: string, file: string) => {
  const target = cg.getNodesByName(methodName).find((n) =>
    n.filePath.endsWith(file) && n.qualifiedName.endsWith(`${className}::${methodName}`)
  );
  if (!target) return [];
  return cg.getCallers(target.id)
    .filter(({ edge }) => edge.kind === 'calls')
    .map(({ node: n }) => n.name)
    .sort();
};

describe('browser global calls (#2907)', () => {
  it('calls on browser globals (window.open, localStorage.getItem, location.reload, history.back) do not link to same-named project methods', () => {
    expect(callersOfMethod('WindowService', 'open', 'services.ts')).toEqual(['openViaService']);
    expect(callersOfMethod('WindowService', 'close', 'services.ts')).toEqual([]);
    expect(callersOfMethod('StorageService', 'getItem', 'services.ts')).toEqual([]);
    expect(callersOfMethod('StorageService', 'setItem', 'services.ts')).toEqual([]);
    expect(callersOfMethod('PageService', 'reload', 'services.ts')).toEqual([]);
    expect(callersOfMethod('PageService', 'back', 'services.ts')).toEqual([]);
  });

  it('keeps edges on custom project router methods and parameters named like globals', () => {
    expect(callersOfMethod('Router', 'back', 'router.ts')).toEqual(['t7']);
    expect(callersOfMethod('Router', 'reload', 'router.ts')).toEqual(['t7']);
    expect(callersOfMethod('Router', 'forward', 'router.ts')).toEqual(['f4']);
    expect(callersOfMethod('Location', 'distanceTo', 'param-global.js')).toEqual(['near']);
  });

  it('preserves callers of same-file functions named like globals', () => {
    expect(callersOf('performance', 'same-file-fn.ts')).toEqual(['m1']);
    expect(callersOf('screen', 'same-file-fn.ts')).toEqual(['m1']);
    expect(callersOf('location', 'same-file-fn.ts')).toEqual(['m1']);
  });
});

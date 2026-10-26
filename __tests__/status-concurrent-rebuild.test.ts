import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

describe('status during live rebuild (#2913)', () => {
  let root: string;
  let writer: DatabaseConnection | null = null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-status-repro-'));
  });

  afterEach(() => {
    if (writer) {
      try {
        writer.close();
      } catch {}
      writer = null;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('codegraph status does not recreate dropped secondary indexes or fail active edge writes', () => {
    const dataDir = path.join(root, '.codegraph');
    fs.mkdirSync(dataDir);
    writer = DatabaseConnection.initialize(path.join(dataDir, 'codegraph.db'));
    const db = writer.getDb();

    for (const id of ['a', 'b']) {
      db.prepare(
        'INSERT INTO nodes ' +
          '(id,kind,name,qualified_name,file_path,language,' +
          'start_line,end_line,start_column,end_column,updated_at) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        'function',
        id,
        id,
        'fixture.ts',
        'typescript',
        1,
        1,
        0,
        1,
        Date.now(),
      );
    }

    const lock = JSON.stringify({
      pid: process.pid,
      mode: 'rebuild',
      startedAt: Date.now(),
      ready: false,
    });
    fs.writeFileSync(path.join(dataDir, 'rebuild.pid'), lock);
    fs.writeFileSync(path.join(dataDir, 'writer.pid'), lock);

    writer.beginBulkEdgeLoad();
    const queries = new QueryBuilder(db);
    const getIds = queries.getExistingNodeIds.bind(queries);

    let observerRan = false;
    let observerStatus: number | null = null;
    let observerStdout = '';

    queries.getExistingNodeIds = (...args) => {
      const ids = getIds(...args);
      const observer = spawnSync(
        process.execPath,
        [BIN, 'status', root, '--json'],
        {
          encoding: 'utf8',
          timeout: 15000,
          cwd: root,
          env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
        },
      );
      observerRan = true;
      observerStatus = observer.status;
      observerStdout = observer.stdout;
      return ids;
    };

    // Before fix, this fails with "database is locked" (SQLITE_BUSY_SNAPSHOT 517)
    // because codegraph status ran open-time secondary index recovery.
    expect(() => {
      queries.insertEdges([{ source: 'a', target: 'b', kind: 'calls' }]);
    }).not.toThrow();

    expect(observerRan).toBe(true);
    expect(observerStatus).toBe(0);
    expect(observerStdout).toContain('nodeCount');
  });
});

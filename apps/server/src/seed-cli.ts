import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildDemoState } from '@relayaid/authority';

const dataDir = process.env.STATION_DATA_DIR ?? join(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'authority.sqlite'));
db.exec(`
  CREATE TABLE IF NOT EXISTS authority_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
`);
db.prepare(
  `INSERT INTO authority_state (id, json) VALUES (1, ?)
   ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
).run(JSON.stringify(buildDemoState()));
db.close();
console.log('Demo shelter restored in the local authority database.');
console.log('Choose Station, Coordinator, or Volunteer in the browser. No token was printed.');

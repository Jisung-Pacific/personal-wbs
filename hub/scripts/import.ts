// One-time migration: load an existing wbs.csv (+ events.csv) into one account's ledger in the hub's database.
// usage: HUB_STORE=firestore GOOGLE_CLOUD_PROJECT=… HUB_FIRESTORE_DB=ppwbs node dist/scripts/import.js <uid> <wbs.csv> [events.csv]
// Refuses a ledger that already has rows. Run it with credentials that may write the hub database (never a browser).
import { readFileSync } from 'node:fs';
import { FirestoreStore } from '../src/store/firestore.js';
import { Ledger } from '../src/wbs/service.js';

const [uid, wbsPath, eventsPath] = process.argv.slice(2);
if (!uid || !wbsPath) { console.error('usage: import.js <uid> <wbs.csv> [events.csv]'); process.exit(2); }
const store = new FirestoreStore(process.env.GOOGLE_CLOUD_PROJECT, process.env.HUB_FIRESTORE_DB || 'ppwbs');
const out = await new Ledger(store).importCsv(uid, readFileSync(wbsPath, 'utf8'), eventsPath ? readFileSync(eventsPath, 'utf8') : undefined);
console.log(`imported into users/${uid}: ${out.rows} rows, ${out.events} events`);

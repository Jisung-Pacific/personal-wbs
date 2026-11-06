// One-time migration: load an existing wbs.csv (+ events.csv) into one account's ledger in the hub's database.
// usage: GOOGLE_CLOUD_PROJECT=… HUB_FIRESTORE_DB=ppwbs HUB_KMS_KEY=projects/…/cryptoKeys/… node dist/scripts/import.js <uid> <wbs.csv> [events.csv]
// Refuses a ledger that already has rows. Rows and history are sealed with the account's data key, as the hub writes them.
// Run it with credentials that may write the hub database and use the KMS key (never a browser).
import { readFileSync } from 'node:fs';
import { FirestoreStore } from '../src/store/firestore.js';
import { KmsKek, LocalKek } from '../src/crypto/envelope.js';
import { Ledger } from '../src/wbs/service.js';

const [uid, wbsPath, eventsPath] = process.argv.slice(2);
if (!uid || !wbsPath) { console.error('usage: import.js <uid> <wbs.csv> [events.csv]'); process.exit(2); }
const kek = process.env.HUB_KMS_KEY ? KmsKek.withDefaultCredentials(process.env.HUB_KMS_KEY)
  : process.env.HUB_LOCAL_KEK && process.env.FIRESTORE_EMULATOR_HOST ? LocalKek.fromBase64(process.env.HUB_LOCAL_KEK) : null;
if (!kek) { console.error('HUB_KMS_KEY is required (HUB_LOCAL_KEK only against the emulator)'); process.exit(2); }
const store = new FirestoreStore(process.env.GOOGLE_CLOUD_PROJECT, process.env.HUB_FIRESTORE_DB || 'ppwbs', kek);
const out = await new Ledger(store).importCsv(uid, readFileSync(wbsPath, 'utf8'), eventsPath ? readFileSync(eventsPath, 'utf8') : undefined);
console.log(`imported into users/${uid}: ${out.rows} rows, ${out.events} events`);

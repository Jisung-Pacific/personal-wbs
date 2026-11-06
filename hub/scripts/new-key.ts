// Prints a fresh ES256 private JWK for HUB_SIGNING_JWK. Pipe it straight into Secret Manager; never into a file in a repo.
// usage: node dist/scripts/new-key.js | gcloud secrets versions add hub-signing-jwk --data-file=-
import { exportJWK, generateKeyPair } from 'jose';
import { randomBytes } from 'node:crypto';

const { privateKey } = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(privateKey)), alg: 'ES256', use: 'sig', kid: 'hub-' + new Date().toISOString().slice(0, 10) + '-' + randomBytes(3).toString('hex') };
process.stdout.write(JSON.stringify(jwk));

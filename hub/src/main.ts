// Entry point: configuration → store → signing key → identity verifier → HTTP server.
import { loadConfig } from './config.js';
import { MemoryStore } from './store/memory.js';
import { FirestoreStore } from './store/firestore.js';
import { TokenIssuer } from './auth/tokens.js';
import { devVerifier, firebaseVerifier } from './auth/identity.js';
import { createApp } from './app.js';
import { KmsKek, LocalKek } from './crypto/envelope.js';
import { appCheckMinter, hostJoiner } from './auth/host.js';

const cfg = loadConfig();
const kek = () => cfg.kmsKey ? KmsKek.withDefaultCredentials(cfg.kmsKey) : LocalKek.fromBase64(cfg.localKek!);
const store = cfg.store === 'firestore' ? new FirestoreStore(cfg.projectId, cfg.firestoreDb, kek(), cfg.allowPlain) : new MemoryStore();
const issuer = await TokenIssuer.create(cfg.publicUrl, cfg.accessTtl, cfg.signingJwk);
const verify = cfg.devLogin ? devVerifier() : firebaseVerifier(cfg.projectId, cfg.checkRevoked);
const joinHost = cfg.host.sessionUrl ? hostJoiner(cfg.host, store, cfg.host.appCheckAppId ? appCheckMinter(cfg.host.appCheckAppId) : undefined) : undefined;
createApp(cfg, store, issuer, verify, joinHost).listen(cfg.port, () => {
  console.log(`ppwbs-hub on :${cfg.port} · store ${cfg.store}${cfg.store === 'firestore' ? ` (${cfg.firestoreDb})` : ''} · issuer ${cfg.publicUrl}${cfg.devLogin ? ' · DEV LOGIN' : ''}`);
});

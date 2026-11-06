// Entry point: configuration → store → signing key → identity verifier → HTTP server.
import { loadConfig } from './config.js';
import { MemoryStore } from './store/memory.js';
import { FirestoreStore } from './store/firestore.js';
import { TokenIssuer } from './auth/tokens.js';
import { devVerifier, firebaseVerifier } from './auth/identity.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const store = cfg.store === 'firestore' ? new FirestoreStore(cfg.projectId, cfg.firestoreDb) : new MemoryStore();
const issuer = await TokenIssuer.create(cfg.publicUrl, cfg.accessTtl, cfg.signingJwk);
const verify = cfg.devLogin ? devVerifier() : firebaseVerifier(cfg.projectId, cfg.checkRevoked);
createApp(cfg, store, issuer, verify).listen(cfg.port, () => {
  console.log(`ppwbs-hub on :${cfg.port} · store ${cfg.store}${cfg.store === 'firestore' ? ` (${cfg.firestoreDb})` : ''} · issuer ${cfg.publicUrl}${cfg.devLogin ? ' · DEV LOGIN' : ''}`);
});

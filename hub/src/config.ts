// Runtime configuration. Everything that differs between deployments comes from the environment; nothing is hard-coded.
//
//   HUB_PUBLIC_URL        https://hub.example.com — the OAuth issuer and the base of every resource URL (no trailing slash)
//   PORT                  listen port (Cloud Run sets it)
//   HUB_STORE             firestore | memory (memory = tests and local runs only)
//   GOOGLE_CLOUD_PROJECT  project that holds Firebase Auth and the hub's Firestore database
//   HUB_FIRESTORE_DB      named Firestore database for the hub (default "ppwbs"), separate from the product's (default) database
//   HUB_SIGNING_JWK       ES256 private key as a JWK (JSON); mounted from Secret Manager. Absent → a per-process key (dev only)
//   HUB_FIREBASE_WEB      JSON {apiKey, authDomain, projectId}: the public web config the sign-in page uses
//   HUB_DEV_LOGIN         1 → the sign-in page accepts a typed uid. Refused when the store is firestore.
//   HUB_ACCESS_TTL        access token lifetime in seconds (default 3600)
//   HUB_REFRESH_TTL       refresh token lifetime in seconds (default 30 days)
//   HUB_CHECK_REVOKED     1 (default) → sign-in also checks the account is not disabled or revoked (needs firebaseauth.users.get)
//   HUB_BRAND             whose accounts these are, as the consent page names them (default "PP WBS")
//   HUB_EXTRA_SCOPES      JSON {scope: {ko, en}}: scopes of services plugged in behind the same accounts (reserved until their tools ship)
//   HUB_KMS_KEY           Cloud KMS CryptoKey that wraps every account's data key (projects/…/cryptoKeys/…). Required in production.
//   HUB_LOCAL_KEK         base64 32-byte key used instead of KMS (tests, the emulator, local runs). Never in production.
//   HUB_ALLOW_PLAINTEXT   1 → also read ledger documents written before encryption (a one-off migration window)
//   HUB_HOST_SESSION_URL  the host product's session endpoint; a connection also makes the person a member there (auth/host.ts)
//   HUB_HOST_NAME         the host product's name on the consent page (default: HUB_BRAND)
//   HUB_HOST_TERMS_URL, HUB_HOST_PRIVACY_URL   the host's terms and privacy policy, linked next to the consent checkbox
//   HUB_HOST_APPCHECK_APP_ID   the hub's app id in the host's Firebase project (App Check custom provider), if the host enforces App Check
//   HUB_HOST_REQUIRED     1 → refuse the connection when joining the host fails (default: connect anyway, retry next time)
//   HUB_HOST_AUTH         none (default) | google-oidc → the join call carries a Google ID token for HUB_HOST_AUDIENCE in
//                         X-Serverless-Authorization: a host API on a private Cloud Run service that lets the hub invoke it
//   HUB_HOST_AUDIENCE     audience of that ID token (default: the origin of HUB_HOST_SESSION_URL)
//   HUB_HOST_CHANNEL      sent as `channel` with the join call, so the host can count where its members came from
//   HUB_AUTH_PROVIDERS    sign-in choices, in order: google, apple, password, oidc.<id>[=Label] (default "google,password");
//                         use the providers the Firebase project already has switched on
//   HUB_PROXY_SECRET      shared with a reverse proxy of your own in front of the service (a Worker on your domain): its
//                         requests that carry it in X-Hub-Proxy are rate-limited by X-Hub-Client-Ip instead of the proxy's address
//   HUB_SUPPORT_EMAIL     contact shown on the public pages (directories ask for one)
//   HUB_OPENAI_APPS_CHALLENGE  the domain-verification token from OpenAI's submission portal, served at /.well-known/openai-apps-challenge

import type { HostConfig } from './auth/host.js';

export interface FirebaseWebConfig { apiKey: string; authDomain: string; projectId: string }
/** One sign-in choice on the consent page: a Firebase Auth provider id and the name shown on its button. */
export interface AuthProvider { id: 'google' | 'apple' | 'password' | `oidc.${string}`; label: string }

export interface Config {
  publicUrl: string;
  port: number;
  store: 'firestore' | 'memory';
  projectId?: string;
  firestoreDb: string;
  signingJwk?: string;
  firebaseWeb?: FirebaseWebConfig;
  devLogin: boolean;
  accessTtl: number;
  refreshTtl: number;
  brand: string;
  checkRevoked: boolean;
  kmsKey?: string;
  localKek?: string;
  allowPlain: boolean;
  host: HostConfig;
  supportEmail?: string;
  openaiChallenge?: string;
  authProviders: AuthProvider[];
  proxySecret?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  registerExtraScopes(env.HUB_EXTRA_SCOPES);
  const publicUrl = (env.HUB_PUBLIC_URL || `http://localhost:${env.PORT || 8787}`).replace(/\/+$/, '');
  const store = env.HUB_STORE === 'firestore' ? 'firestore' : 'memory';
  const devLogin = env.HUB_DEV_LOGIN === '1';
  if (devLogin && store === 'firestore') throw new Error('HUB_DEV_LOGIN is for local runs only; it cannot be combined with the firestore store');
  if (store === 'firestore' && !env.HUB_SIGNING_JWK) throw new Error('HUB_SIGNING_JWK is required with the firestore store');
  if (!/^https:\/\//.test(publicUrl) && store === 'firestore') throw new Error('HUB_PUBLIC_URL must be https in production');
  if (store === 'firestore' && !env.HUB_KMS_KEY && !(env.HUB_LOCAL_KEK && env.FIRESTORE_EMULATOR_HOST))
    throw new Error('HUB_KMS_KEY is required with the firestore store (HUB_LOCAL_KEK only against the emulator)');
  return {
    publicUrl,
    port: Number(env.PORT || 8787),
    store,
    projectId: env.GOOGLE_CLOUD_PROJECT,
    firestoreDb: env.HUB_FIRESTORE_DB || 'ppwbs',
    signingJwk: env.HUB_SIGNING_JWK,
    firebaseWeb: env.HUB_FIREBASE_WEB ? JSON.parse(env.HUB_FIREBASE_WEB) as FirebaseWebConfig : undefined,
    devLogin,
    accessTtl: Number(env.HUB_ACCESS_TTL || 3600),
    refreshTtl: Number(env.HUB_REFRESH_TTL || 30 * 24 * 3600),
    brand: env.HUB_BRAND || 'PP WBS',
    checkRevoked: env.HUB_CHECK_REVOKED !== '0',
    kmsKey: env.HUB_KMS_KEY || undefined,
    localKek: env.HUB_LOCAL_KEK || undefined,
    allowPlain: env.HUB_ALLOW_PLAINTEXT === '1',
    host: {
      name: env.HUB_HOST_NAME || env.HUB_BRAND || 'PP WBS',
      sessionUrl: httpsOrLocal(env.HUB_HOST_SESSION_URL, store),
      termsUrl: httpsOrLocal(env.HUB_HOST_TERMS_URL, store),
      privacyUrl: httpsOrLocal(env.HUB_HOST_PRIVACY_URL, store),
      appCheckAppId: env.HUB_HOST_APPCHECK_APP_ID || undefined,
      required: env.HUB_HOST_REQUIRED === '1',
      auth: hostAuth(env.HUB_HOST_AUTH),
      audience: env.HUB_HOST_AUDIENCE || (env.HUB_HOST_SESSION_URL ? new URL(env.HUB_HOST_SESSION_URL).origin : undefined),
      channel: channel(env.HUB_HOST_CHANNEL),
    },
    supportEmail: env.HUB_SUPPORT_EMAIL || undefined,
    openaiChallenge: env.HUB_OPENAI_APPS_CHALLENGE || undefined,
    authProviders: parseProviders(env.HUB_AUTH_PROVIDERS),
    proxySecret: proxySecret(env.HUB_PROXY_SECRET),
  };
}

function hostAuth(v: string | undefined): 'none' | 'google-oidc' {
  if (!v || v === 'none') return 'none';
  if (v === 'google-oidc') return v;
  throw new Error(`HUB_HOST_AUTH must be none or google-oidc, not ${v}`);
}
function channel(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(v)) throw new Error('HUB_HOST_CHANNEL: 2–32 characters, a–z, 0–9, _ or -');
  return v;
}
function proxySecret(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (v.length < 32) throw new Error('HUB_PROXY_SECRET must be at least 32 characters');
  return v;
}

/** HUB_AUTH_PROVIDERS → the consent page's sign-in choices, in the order given. */
export function parseProviders(v: string | undefined): AuthProvider[] {
  const out: AuthProvider[] = [];
  for (const raw of (v || 'google,password').split(',').map(x => x.trim()).filter(Boolean)) {
    const at = raw.indexOf('='), id = at < 0 ? raw : raw.slice(0, at), label = at < 0 ? '' : raw.slice(at + 1).trim().slice(0, 24);
    if (id === 'google') out.push({ id, label: label || 'Google' });
    else if (id === 'apple') out.push({ id, label: label || 'Apple' });
    else if (id === 'password') out.push({ id, label: label || '이메일' });
    else if (/^oidc\.[a-z0-9-]{1,30}$/.test(id)) out.push({ id: id as `oidc.${string}`, label: label || id.slice(5) });
    else throw new Error(`HUB_AUTH_PROVIDERS: unknown provider ${id}`);
  }
  if (!out.length) throw new Error('HUB_AUTH_PROVIDERS names no provider');
  return out;
}

/** An https URL (http on localhost is allowed for local runs and tests); empty → undefined. */
function httpsOrLocal(v: string | undefined, store: string): string | undefined {
  if (!v) return undefined;
  const u = new URL(v);
  if (u.protocol === 'https:' || (store === 'memory' && u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return u.toString();
  throw new Error(`${v} must be https`);
}

// The scopes a client may ask for. Reserved scopes are accepted in requests but grant nothing until their tools exist.
export const SCOPES: Record<string, { ko: string; en: string; reserved?: boolean }> = {
  'wbs.read': { ko: '작업 원장 읽기', en: 'Read your work ledger' },
  'wbs.write': { ko: '작업 원장에 기록', en: 'Record work in your ledger' },
  'mind.read': { ko: '마음 기록 읽기', en: 'Read your journal', reserved: true },
  'mind.write': { ko: '마음 기록 쓰기', en: 'Write to your journal', reserved: true },
};
/** Adds the scopes of plugged-in services (HUB_EXTRA_SCOPES) once at start-up; they stay reserved until their tools exist. */
export function registerExtraScopes(json?: string) {
  if (!json) return;
  for (const [k, v] of Object.entries(JSON.parse(json) as Record<string, { ko: string; en: string }>)) {
    if (!/^[a-z][a-z0-9_.-]{2,40}$/.test(k)) throw new Error(`bad scope name ${k}`);
    SCOPES[k] = { ko: v.ko, en: v.en, reserved: true };
  }
}
export const DEFAULT_SCOPE = 'wbs.read wbs.write';

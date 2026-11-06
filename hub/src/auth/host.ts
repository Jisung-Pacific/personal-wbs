// Membership in the host product.
//
// The hub signs people in with the host product's Firebase Auth, so a hub account is already an identity in the host's user
// pool. This step also makes that identity a member of the host product itself: when someone allows a connection, the hub
// hands the verified ID token to the host's own session endpoint, which creates the member on the first sign-in (and only
// signs in afterwards), exactly as the host's apps do — the host keeps its own rules for who may join. The host session's
// refresh token is kept for the account, sealed with the account's data key, for host tools the hub will offer later.
//
// Configured by HUB_HOST_* (see config.ts). Without a session URL the hub runs on its own and this step is skipped.
// The endpoint is called as POST {identityToken, timezone, locale} (+ `channel` when HUB_HOST_CHANNEL is set, so the host
// can count members who came through the hub). Two ways to satisfy a host that does not take calls from just anyone:
//   - HUB_HOST_AUTH=google-oidc: the host API is a private Cloud Run service that grants the hub's service account
//     roles/run.invoker; the call carries a Google ID token in X-Serverless-Authorization (Authorization stays free)
//   - HUB_HOST_APPCHECK_APP_ID: the call carries an App Check token the hub mints for its own registered app
//     (a custom App Check provider), so a host that enforces App Check accepts it without the browser being involved
import type { Store } from '../store/types.js';

export interface HostConfig {
  name: string;            // shown on the consent page, e.g. the product's name
  sessionUrl?: string;     // the host's session endpoint; empty → no membership step
  termsUrl?: string;
  privacyUrl?: string;
  appCheckAppId?: string;  // the hub's app id in the host's Firebase project, for App Check tokens
  required: boolean;       // true → a failed join refuses the connection; false → connect anyway and retry next time
  auth?: 'none' | 'google-oidc';
  audience?: string;       // audience of the Google ID token (google-oidc)
  channel?: string;        // where the member came from, for the host's own counts
}

export interface JoinContext { timezone: string; locale: 'ko' | 'en' }
export type JoinResult = 'joined' | 'skipped' | 'failed';
export type JoinHost = (uid: string, idToken: string, ctx: JoinContext) => Promise<JoinResult>;

/** IANA zone names only; anything else falls back to UTC. */
export function cleanTimezone(tz: string | undefined): string {
  const t = String(tz || '');
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(t) || t.length > 64) return 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: t }); return t; } catch { return 'UTC'; }
}
export const cleanLocale = (l: string | undefined): 'ko' | 'en' => /^ko\b/i.test(String(l || '')) ? 'ko' : 'en';

export function hostJoiner(host: HostConfig, store: Store, appCheckToken?: () => Promise<string>, fetchImpl: typeof fetch = fetch,
  serviceToken?: () => Promise<string>): JoinHost {
  return async (uid, idToken, ctx) => {
    if (!host.sessionUrl) return 'skipped';
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      if (appCheckToken) headers['x-firebase-appcheck'] = await appCheckToken();
      if (serviceToken) headers['x-serverless-authorization'] = `Bearer ${await serviceToken()}`;
      const r = await fetchImpl(host.sessionUrl, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ identityToken: idToken, timezone: cleanTimezone(ctx.timezone), locale: ctx.locale, ...(host.channel ? { channel: host.channel } : {}) }),
      });
      if (!r.ok) throw new Error(`session endpoint answered ${r.status}`);
      const body = await r.json().catch(() => ({})) as { refreshToken?: unknown };
      await store.putSecret(uid, 'host_member', { host: host.name, since: Date.now() });
      if (typeof body.refreshToken === 'string' && body.refreshToken) await store.putSecret(uid, 'host_session', { refreshToken: body.refreshToken, at: Date.now() });
      return 'joined';
    } catch (e) {
      console.error(JSON.stringify({ severity: 'WARNING', message: 'host membership step failed', uid, error: String((e as Error).message || e) }));   // never the token
      return 'failed';
    }
  };
}

/** App Check tokens for the hub's own app, minted with the Admin SDK and reused until shortly before they expire. */
export function appCheckMinter(appId: string): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const { getApps, initializeApp } = await import('firebase-admin/app');
    const { getAppCheck } = await import('firebase-admin/app-check');
    const t = await getAppCheck(getApps()[0] || initializeApp()).createToken(appId, { ttlMillis: 60 * 60_000 });
    cached = { token: t.token, until: Date.now() + Math.max(60_000, t.ttlMillis - 5 * 60_000) };
    return t.token;
  };
}

/** Google ID tokens for the host's private Cloud Run API, from the runtime's own service account (metadata server).
 *  The library keeps each token until shortly before it expires; a failed fetch is retried on the next join. */
export function googleIdToken(audience: string): () => Promise<string> {
  let client: Promise<{ getRequestHeaders(): Promise<Headers> }> | null = null;
  return async () => {
    try {
      client ??= import('google-auth-library').then(({ GoogleAuth }) => new GoogleAuth().getIdTokenClient(audience));
      const v = (await (await client).getRequestHeaders()).get('authorization') || '';
      if (!/^Bearer \S+$/.test(v)) throw new Error('no ID token for the host audience');
      return v.slice(7);
    } catch (e) { client = null; throw e; }
  };
}

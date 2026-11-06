// Who signed in on the consent page. In production this is a Firebase Auth ID token from the product's own user pool
// (Google or email sign-in), so a hub account is the same account as the product's. Locally, "dev:<uid>" stands in.
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export interface Identity { uid: string; email?: string; name?: string }
export type VerifyIdToken = (idToken: string) => Promise<Identity>;

/** checkRevoked asks Firebase whether the account was disabled or signed out everywhere; it needs firebaseauth.users.get. */
export function firebaseVerifier(projectId?: string, checkRevoked = true): VerifyIdToken {
  const app = getApps()[0] || initializeApp(projectId ? { projectId } : undefined);
  const auth = getAuth(app);
  return async idToken => {
    const t = await auth.verifyIdToken(idToken, checkRevoked);
    return { uid: t.uid, email: t.email, name: t.name as string | undefined };
  };
}

export function devVerifier(): VerifyIdToken {
  return async idToken => {
    const m = /^dev:([A-Za-z0-9_-]{3,64})$/.exec(idToken);
    if (!m) throw new Error('dev sign-in expects dev:<uid>');
    return { uid: m[1] };
  };
}

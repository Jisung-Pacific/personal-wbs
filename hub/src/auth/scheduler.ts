// Who may start the weekly run (POST /internal/weekly): Cloud Scheduler, signing in as the hub's scheduler service
// account with a Google-signed OIDC ID token whose audience is that exact URL. Nothing else starts it; the run itself
// does only what the first reader of last week's brief would have done anyway (src/wbs/weekly.ts).
import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Resolves true only for a valid token from the scheduler's account; never throws. */
export type VerifyScheduler = (token: string) => Promise<boolean>;

/** Google's ID-token signing keys and issuers (https://developers.google.com/identity/openid-connect/openid-connect). */
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export function googleScheduler(serviceAccount: string, audience: string): VerifyScheduler {
  const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS));
  return async token => {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: GOOGLE_ISSUERS, audience, algorithms: ['RS256'], clockTolerance: 30 });
      return payload.email === serviceAccount && payload.email_verified === true;
    } catch {
      return false;
    }
  };
}

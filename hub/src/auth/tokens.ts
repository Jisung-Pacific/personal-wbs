// Token material. Access tokens are ES256 JWTs (short-lived, audience-bound per RFC 8707) so any service that trusts the
// hub (a service plugged in behind the same accounts, say) can verify them offline against /.well-known/jwks.json. Refresh tokens, codes and
// request ids are random opaque strings; only their SHA-256 is stored.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, importJWK, jwtVerify, type JWK, type CryptoKey } from 'jose';

export const random = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** PKCE S256: base64url(SHA-256(verifier)) must equal the challenge sent to /authorize. */
export function pkceOk(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash('sha256').update(verifier).digest('base64url')), b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface AccessClaims { uid: string; clientId: string; clientName: string; scopes: string[]; resource: string; exp: number }

export class TokenIssuer {
  private constructor(private issuer: string, private key: CryptoKey, private verifyKey: CryptoKey, private pub: JWK, private ttl: number) {}

  /** Loads the signing key from a private JWK (production) or makes one for this process (local runs and tests). */
  static async create(issuer: string, ttl: number, privateJwk?: string): Promise<TokenIssuer> {
    if (privateJwk) {
      const jwk = JSON.parse(privateJwk) as JWK;
      const key = await importJWK(jwk, 'ES256') as CryptoKey;
      const { d: _d, ...pub } = jwk;
      return new TokenIssuer(issuer, key, await importJWK(pub, 'ES256') as CryptoKey, { ...pub, alg: 'ES256', use: 'sig', kid: jwk.kid || 'hub-1' }, ttl);
    }
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    return new TokenIssuer(issuer, privateKey, publicKey, { ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig', kid: 'dev-' + random(6) }, ttl);
  }

  jwks() { return { keys: [this.pub] }; }

  async access(uid: string, clientId: string, clientName: string, scope: string, resource: string): Promise<{ token: string; expiresIn: number }> {
    const token = await new SignJWT({ scope, client_id: clientId, client_name: clientName })
      .setProtectedHeader({ alg: 'ES256', kid: this.pub.kid, typ: 'at+jwt' })   // RFC 9068 access token profile
      .setIssuer(this.issuer).setSubject(uid).setAudience(resource)
      .setIssuedAt().setJti(random(12)).setExpirationTime(`${this.ttl}s`).sign(this.key);
    return { token, expiresIn: this.ttl };
  }

  /** Verifies signature, issuer, expiry and that the token was minted for one of `audiences`. */
  async verify(token: string, audiences: string[]): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.verifyKey, { issuer: this.issuer, audience: audiences, typ: 'at+jwt', algorithms: ['ES256'] });
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    return { uid: String(payload.sub), clientId: String(payload.client_id), clientName: String(payload.client_name || ''), scopes: String(payload.scope || '').split(' ').filter(Boolean), resource: String(aud), exp: Number(payload.exp) };
  }
}

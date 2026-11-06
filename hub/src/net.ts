// Who is calling, for rate limiting. Cloud Run's front end names the peer in X-Forwarded-For (app 'trust proxy' 1).
// A reverse proxy of the operator's own in front (a Worker on their domain) would make every caller look like the proxy,
// so its requests may name the real caller instead — only when they also present the shared HUB_PROXY_SECRET.
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';

export function clientAddress(req: Request, proxySecret?: string): string {
  const presented = req.get('x-hub-proxy');
  if (proxySecret && presented) {
    const a = Buffer.from(presented), b = Buffer.from(proxySecret), ip = (req.get('x-hub-client-ip') || '').trim();
    if (a.length === b.length && timingSafeEqual(a, b) && isIP(ip)) return ip;
  }
  return req.ip || '';
}

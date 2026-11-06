// The PP WBS Hub under your own domain: a Cloudflare Worker (Custom Domain) in front of the hub's Cloud Run address.
// Cloud Run domain mapping is not offered in every region (not in asia-northeast3, for one), so the hub keeps its run.app
// origin and this Worker serves it under your name. Streaming (MCP over Streamable HTTP) passes straight through.
//
//   vars    ORIGIN            the hub's run.app address, e.g. https://ppwbs-hub-123456789012.asia-northeast3.run.app
//   secret  HUB_PROXY_SECRET  the value bootstrap printed with PROXY=1 (`wrangler secret put HUB_PROXY_SECRET`)
//
// The hub must have been bootstrapped with PUBLIC_URL=https://<this domain> (its OAuth issuer) and PROXY=1; with the
// shared secret it rate-limits by the real caller (X-Hub-Client-Ip) instead of by this Worker's address.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.ORIGIN || !env.HUB_PROXY_SECRET) return new Response('proxy is not configured', { status: 503 });
    const headers = new Headers(request.headers);
    for (const h of ['x-hub-proxy', 'x-hub-client-ip']) headers.delete(h);   // only this Worker may set them
    headers.set('x-hub-proxy', env.HUB_PROXY_SECRET);
    headers.set('x-hub-client-ip', request.headers.get('cf-connecting-ip') || '');
    headers.set('x-forwarded-host', url.host);
    const upstream = await fetch(new URL(url.pathname + url.search, env.ORIGIN), {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',   // the hub's redirects already point at its issuer (this domain) or at the client's redirect_uri
    });
    return new Response(upstream.body, upstream);
  },
};

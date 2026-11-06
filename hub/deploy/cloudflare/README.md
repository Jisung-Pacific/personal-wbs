# The hub under your own domain (Cloudflare)

Cloud Run domain mapping is not available in every region, so the hub keeps its `run.app` address and a small Worker
serves it under your domain. Order matters, because the issuer is fixed once agents connect:

1. Bootstrap (or rerun bootstrap) with `PUBLIC_URL=https://<your host> PROXY=1`. Note the printed proxy-secret command.
2. Deploy this Worker with a Custom Domain on that host (`wrangler.toml.example`), set `ORIGIN` to the hub's run.app
   address and the secret: `gcloud secrets versions access <n> --secret=ppwbs-hub-proxy-secret | npx wrangler secret put HUB_PROXY_SECRET`.
   Without wrangler: Workers & Pages → Create → Worker, paste `worker.js`, add the variable and the secret, then
   Settings → Domains & Routes → Custom domain.
3. Firebase Authentication → Authorized domains: add the host.
4. Let the agents' servers through. Claude, ChatGPT and the other MCP clients call from their own clouds, with no browser
   to solve a challenge, so nothing on this host may challenge or geo-block them:
   - WAF custom rule `(http.host eq "<your host>")` → Skip (remaining custom rules, rate limiting rules, managed rules).
   - Configuration Rule for the same host → Browser Integrity Check off.
   - Bot Fight Mode (free plans) cannot be skipped by any rule; it must stay off for the zone, or use Super Bot Fight
     Mode, which honours a Skip rule.
     ([Cloudflare: Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/))
5. Check: `curl -s https://<your host>/.well-known/oauth-authorization-server` returns the issuer `https://<your host>`.

The hub checks every token itself, so the Worker adds no trust of its own; it only names the caller for rate limiting,
and the hub believes that only with the shared secret.

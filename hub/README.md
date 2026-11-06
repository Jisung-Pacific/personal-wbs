# PP WBS Hub

One work ledger per account, behind OAuth, written and read by every agent the person uses: Claude, ChatGPT, Gemini,
Grok, DeepSeek, Kimi, CLIs and scripts. The dashboard artifact becomes a view; the hub is where the ledger lives.

The hub runs inside an existing Firebase project and shares its Firebase Auth users, so an account of that product is
a hub account. Its data sits in a separate Firestore database that only the hub's own service account can reach.

## What it serves

| Path | For |
| --- | --- |
| `/mcp` | MCP over Streamable HTTP (stateless). Tools: `wbs_search`, `wbs_get`, `wbs_packages`, `wbs_summary`, `wbs_export`, and with `wbs.write` also `wbs_add`, `wbs_update`. A client sees only the tools its scopes allow. |
| `/oauth/*` | OAuth 2.1 authorization server: PKCE S256, dynamic client registration (RFC 7591), client ID metadata documents, confidential clients for GPT Actions, refresh rotation with reuse detection, revocation (RFC 7009), `iss` in responses (RFC 9207). |
| `/v1/*`, `/openapi.json` | REST for agents that call HTTP functions (GPT Actions, DeepSeek or Kimi function calling, scripts). |
| `/.well-known/*` | Protected-resource metadata (RFC 9728) per resource, server metadata (RFC 8414), JWKS. |

Ledger rules live in the tools: one concrete result per row, codes assigned by the hub (next free number, never
reused), a near-duplicate is refused with the existing rows, every change is kept in the history, the task text is
never rewritten (a new result becomes a dated step).

## Connect an agent

Use the MCP URL `https://<hub>/mcp` unless the agent only takes OpenAPI.

| Agent | How |
| --- | --- |
| Claude (claude.ai, desktop, mobile, Claude Code) | Add a custom connector with the URL. OAuth client: "Use Claude's published identity" (client ID metadata document) or "Register automatically". Artifacts reach it through the page's MCP capability. |
| ChatGPT | Developer mode → add a connector with the URL; OAuth. Write tools need developer mode. |
| Gemini app | Custom app from the URL (Google currently limits this to personal accounts, 18+, in the US, in English). Gemini CLI: add as an MCP server. |
| Grok | xAI API remote MCP tool with the URL; pass an access token in `authorization`. |
| GPT Actions | Import `https://<hub>/openapi.json`. Register a confidential client once: `POST /oauth/register` with `token_endpoint_auth_method: client_secret_basic` and the callback URL the GPT builder shows; enter the returned id and secret. |
| DeepSeek, Kimi, others | Give the model the OpenAPI operations as functions; the app holding the OAuth token calls `/v1`. |

## Security model

- **Accounts**: Firebase Auth of the host project (Google or email). The consent page shows the client, its redirect
  host and the scopes; the ID token is verified, including revocation (`HUB_CHECK_REVOKED`).
- **Data**: a separate Firestore database with deny-all Security Rules; the hub's service account holds
  `roles/datastore.user` on that database alone (IAM condition). Every call is scoped to the token's account.
- **Tokens**: ES256 JWT access tokens (1 h) bound to one resource (`/mcp`, `/v1` or the hub); refresh tokens (30 days)
  rotate and a reused one revokes the grant; codes (5 min) and parked requests (10 min) work once. Only SHA-256 hashes
  of secrets are stored, and a TTL policy removes expired OAuth state.
- **Client metadata documents** are fetched with guards: https, public addresses only, no redirects, 64 KB, 5 s.
- **Consent page**: strict CSP (Firebase Auth only), `frame-ancestors 'none'`, form posts only to the hub and the
  client's registered redirect.

## Run and test locally

```bash
npm ci && npm test                     # end-to-end over HTTP with the memory store and dev sign-in
HUB_TEST_LEDGER=wbs.csv HUB_TEST_EVENTS=events.csv npm test   # plus a byte-exact round trip of a real ledger
HUB_DEV_LOGIN=1 npm start              # http://localhost:8787 — dev sign-in takes a typed uid
firebase emulators:exec --only firestore "FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node --test dist/test/firestore.test.js"
```

## Deploy (Cloud Run, Terraform)

1. Pick the project and region (a Firestore location cannot change later). Start with a dev project.
2. Build and push the image; use its digest: `gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT/REPO/ppwbs-hub`.
3. Create the signing key: `terraform apply -target=google_secret_manager_secret.signing_jwk`, then
   `node dist/scripts/new-key.js | gcloud secrets versions add ppwbs-hub-signing-jwk --data-file=-`.
4. Fill `deploy/terraform` variables (project, region, image digest, public URL, the project's public Firebase web
   config, key version) in an untracked `.tfvars`; `terraform plan`, review, `terraform apply`.
5. Firebase Auth: add the hub's domain to Authorized domains, and enable the Google provider if it is off.
6. Map a custom domain if wanted, and set `public_url` to it (it is the OAuth issuer; changing it invalidates tokens).
7. Import an existing ledger: `HUB_STORE=firestore GOOGLE_CLOUD_PROJECT=… node dist/scripts/import.js <uid> wbs.csv events.csv`.
8. Connect Claude first, then the other agents.

## Services behind the same accounts

Another service of the host product can sit behind the same sign-in: list its scopes in `HUB_EXTRA_SCOPES` (shown on
the consent page, reserved until its tools ship), let it verify hub tokens offline against `/.well-known/jwks.json`
(issuer = the hub, audience = its resource), and expose its operations as hub tools.

# PP WBS Hub

One work ledger per account, behind OAuth, written and read by every agent the person uses: Claude, ChatGPT, Gemini,
Grok, DeepSeek, Kimi, CLIs and scripts. The dashboard artifact becomes a view; the hub is where the ledger lives.

The hub runs inside an existing Firebase project and shares its Firebase Auth users, so an account of that product is
a hub account. Its data sits in a separate Firestore database that only the hub's own service account can reach.

## What it serves

| Path | For |
| --- | --- |
| `/mcp` | MCP over Streamable HTTP (stateless). Tools: `wbs_search`, `wbs_get`, `wbs_packages`, `wbs_brief`, `wbs_summary`, `wbs_export`, `wbs_spaces`, `wbs_charter`, `wbs_plan`, `wbs_shared`, `wbs_views`, `wbs_team`, and with `wbs.write` also `wbs_add`, `wbs_update`, `wbs_plan_put`, `wbs_share`; each ledger tool takes an optional `space` (a team space id; default the personal ledger). A client sees only the tools its scopes allow. |
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
- **Encryption layer**: every account has its own random 256-bit data key, stored only wrapped by a Cloud KMS key
  (bound to the account). Rows, history lines and stored credentials are sealed with AES-256-GCM under that key, each
  bound to its account and path, so the database, its exports and backups hold ciphertext; only the year and code of a
  row stay readable for queries. The runtime may use that one KMS key and nothing else; deleting an account deletes its
  wrapped key first, which makes every copy unreadable (crypto-shredding). Code: `src/crypto/envelope.ts`.
- **Spaces**: an account's own ledger is its personal space. A team space (one owner, equal members, guests who read
  only the projects they are assigned, at most 10 people) keeps its ledger under `spaces/<id>` with its own data key,
  sealed apart from every member's personal ledger; only memberships (account id, role, a guest's project codes) stay
  readable, so access can be checked. Who may do what comes from one permission table (`src/wbs/access.ts`) over those
  relation tuples: agents act within their person's role and granted scopes and never manage a space (inviting, billing,
  the charter, handing over, deleting stay with people); outsiders are told a space does not exist. Deleting a space
  shreds its key first; an account that owns a space with other members hands it over before it can be deleted.
  A team space opens once a charter (at most 9 lines) is in force, which takes every owner's and member's agreement;
  each of them enters after agreeing to the version in force, a change takes effect only when everyone agrees, and every
  version stays with its dated answers as the change record. Agreeing and proposing are people's acts, never an agent's.
- **Team plan and shared work**: a team space keeps a plan, its project WBS (scope, deliverable, done criterion,
  prerequisites, owners and planned dates under codes of its own, permanent and parked rather than deleted), sealed under
  the space's key. Work stays in each person's own ledger: a person links a row to a plan item and chooses the fields the
  team sees, by default title, status, dates and deliverable links, with blocker details, the row's goal, evidence and
  the full text only when they choose. The hub copies just those fields into the space under an id that does not reveal the person's own
  code and keeps the copy in step with the row; unlinking withdraws it, and leaving the space or becoming a guest freezes
  it with the team, as the charter says. `wbs_plan` (REST `GET /v1/plan`) shows the plan against that work: per item the
  linked rows (rolled up to parents), how many are done, their state and dates, days late against the due date, and
  flags (late, in progress with no work, plan done with work open, work done with the plan open, work on a parked item,
  waiting on others); members see who did the work, guests and the team's agent see counts.
- **Intent alignment**: the team writes down why it works — at most five active intents, each a why, what and how,
  ranked, retired rather than deleted (`wbs_plan_put` with `intents`) — and plan items point at the intent they serve;
  a child inherits its parent's. `wbs_plan` with `view: "alignment"` (REST `GET /v1/plan?view=alignment`) sets each
  intent against the shared work under its items: plan items and work rows (done of all), its share of the team's work,
  who worked on it, the goals (목표) people gave those rows where they shared them, and flags for an intent with no plan,
  a plan but no work, or at least 20 points less of the work than a lower-ranked intent; then the plan items that serve
  no intent and the work on them, and per person (owners and members see each other's, as the charter says; the team's
  agent sees counts; guests do not see it). Plan against actual names each item's intent, own or inherited. A team
  space's `wbs_brief` and `wbs_team` carry the alignment too.
- **View log**: who read a person's shared rows is noted in that person's own space (the charter: views are visible to
  the one viewed) — the reader's account and role, the agent it read through or the team's own agent, the space, how
  many of the person's rows one read carried, and when (first and last time each day, how often). Only the person reads
  it (`wbs_views`, REST `GET /v1/views`); their own reads are not noted, nothing is written for someone who has left the
  space, and days expire after 180 days (Firestore TTL on `views`).
- **Team screen**: `wbs_team` (REST `GET /v1/team`) returns what a page shows when someone switches to a team space, in
  one call and within the permission table: the space and the caller's role, the charter in force and any open
  proposal, the members (owners and members only), the plan against the actual work, the intent alignment (not for guests), the caller's own shared rows and
  who read them. The dashboard's space switcher calls it through the person's own claude.ai connector to the hub.
- **Tokens**: ES256 JWT access tokens (1 h) bound to one resource (`/mcp`, `/v1` or the hub); refresh tokens (30 days)
  rotate and a reused one revokes the grant; codes (5 min) and parked requests (10 min) work once. Only SHA-256 hashes
  of secrets are stored, and a TTL policy removes expired OAuth state.
- **Client metadata documents** are fetched with guards: https, public addresses only, no redirects, 64 KB, 5 s.
- **Consent page**: strict CSP (Firebase Auth only), `frame-ancestors 'none'`, form posts only to the hub and the
  client's registered redirect.

## Membership in the host product

When the hub runs inside a product's Firebase project, a connection can also make the person a member of that product:
the consent page names the product, links its terms and privacy policy and asks for agreement, and on "allow" the hub
hands the verified ID token to the product's own session endpoint (`HUB_HOST_SESSION_URL`, called as
`POST {identityToken, timezone, locale}`), which creates the member on the first sign-in exactly as the product's apps
do. The product's session is kept sealed for the account, for product tools the hub will expose later. If the product
enforces App Check, register the hub as an app there and set `HUB_HOST_APPCHECK_APP_ID`; the hub mints its own App Check
tokens. `HUB_HOST_REQUIRED=1` refuses a connection when joining fails; by default it connects and retries next time.

## Run and test locally

```bash
npm ci && npm test                     # end-to-end over HTTP with the memory store and dev sign-in
HUB_TEST_LEDGER=wbs.csv HUB_TEST_EVENTS=events.csv npm test   # plus a byte-exact round trip of a real ledger
HUB_DEV_LOGIN=1 npm start              # http://localhost:8787 — dev sign-in takes a typed uid
firebase emulators:exec --only firestore "FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node --test dist/test/firestore.test.js"
```

## Deploy (Cloud Run, Terraform, continuous)

1. In Cloud Shell of the Firebase project, from a clone of this repository: `PROJECT=<id> bash hub/deploy/bootstrap.sh`.
   Everything else is worked out: the service's own `run.app` address as the issuer, the project's web config and its
   switched-on sign-in providers (Google, Apple, OIDC providers such as Kakao, email), Terraform state in a versioned
   bucket of the project, and this clone's repository and branch for continuous deploys. `PLAN_ONLY=1` prints the full
   plan and creates nothing. It stops for your `yes` before every apply and creates only new resources: the database,
   rules, TTL, KMS key, service account, the service and the keyless CI deployer.
2. Set the printed `ci_variables` as GitHub repository variables. From then on every push to the deploy ref that touches
   `hub/` is tested, built and rolled out (`.github/workflows/hub-deploy.yml`).
3. Firebase Auth: add the hub's host name to Authorized domains (in the project's own Terraform if it keeps the list there).
4. Your own domain: put a reverse proxy in front (`deploy/cloudflare`; Cloud Run domain mapping is not offered in every
   region), rerun bootstrap with `PROXY=1 PUBLIC_URL=https://<domain>` before anyone connects, since the issuer is fixed.
5. Import an existing ledger: `GOOGLE_CLOUD_PROJECT=… HUB_KMS_KEY=… node dist/scripts/import.js <uid> wbs.csv events.csv`.
   It reads everything back through the database and the data key and exits non-zero unless the export equals the files.
   A ledger kept oldest year first keeps that order when exported with `order=oldest` (`/v1/export?order=oldest`, or
   the `order` argument of `wbs_export`); the default is newest year first.
6. Connect Claude first, then the other agents.

Planning and advising agents start from `wbs_brief` (REST `GET /v1/brief`): status counts, six-month flow, where the
effort went in the last 90 days, open, overdue and soon-due work, what waits on others, work-style indicators from the
person's own rows, and the signals worth acting on — about a thousand tokens — then drill down with `wbs_search`.

## Services behind the same accounts

Another service of the host product can sit behind the same sign-in: list its scopes in `HUB_EXTRA_SCOPES` (shown on
the consent page, reserved until its tools ship), let it verify hub tokens offline against `/.well-known/jwks.json`
(issuer = the hub, audience = its resource), and expose its operations as hub tools.

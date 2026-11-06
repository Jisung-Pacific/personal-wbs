// The hub's public pages: how to connect each agent (the page directories link to as documentation), and the privacy
// notice they require. Korean or English by the browser's language. Everything is derived from the configuration, so a
// deployment shows its own address, brand and contact.
import type { Config } from './config.js';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const pickLang = (accept: string | undefined): 'ko' | 'en' => /^\s*ko\b/i.test(accept || '') || /(^|,)\s*ko\b[^,]*;q=1/i.test(accept || '') ? 'ko' : 'en';

const STYLE = `:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--muted:#5b6475;--line:#dfe3ea;--accent:#2f5bd3;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1a1f27;--fg:#e8ebf1;--muted:#a2abbb;--line:#2c3340;--accent:#7c9cff;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
main{max-width:760px;margin:0 auto;padding:28px max(16px,env(safe-area-inset-left)) 48px}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.sub{color:var(--muted);margin:0 0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:10px 0}
.card h3{font-size:15px;margin:0 0 4px}.card p{margin:4px 0}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
a{color:var(--accent)}.url{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.url code{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;word-break:break-all}
.foot{margin-top:32px;color:var(--muted);font-size:13px}`;

function page(lang: string, title: string, body: string) {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

/** One card per kind of client: where to paste the MCP URL, or the snippet / link that does it. */
export function landingPage(cfg: Config, lang: 'ko' | 'en'): string {
  const u = cfg.publicUrl, mcp = `${u}/mcp`, ko = lang === 'ko', brand = cfg.brand;
  const cursorCfg = Buffer.from(JSON.stringify({ url: mcp })).toString('base64');
  const card = (title: string, text: string, extra = '') => `<div class="card"><h3>${title}</h3><p>${text}</p>${extra}</div>`;
  const pre = (s: string) => `<pre>${esc(s)}</pre>`;
  const cards = ko ? [
    card('Claude (웹·데스크톱·모바일)', '설정 → 커넥터 → 사용자 지정 커넥터 추가에 아래 MCP 주소를 넣고, 열리는 창에서 로그인·허용합니다.'),
    card('Claude Code', '터미널에서:', pre(`claude mcp add --transport http pp-wbs ${mcp}`)),
    card('ChatGPT', '설정의 앱·커넥터에서 개발자 모드를 켜고 MCP 서버 주소로 추가합니다. 디렉터리에 등록되면 앱 목록에서 바로 연결됩니다.'),
    card('Grok', '<a href="https://grok.com/connectors" target="_blank" rel="noopener">grok.com/connectors</a> → New Connector → Custom 에 MCP 주소를 넣습니다.'),
    card('Le Chat (Mistral) · Perplexity', '커넥터 설정의 사용자 지정 MCP 커넥터에 주소를 넣고 OAuth로 로그인합니다(조직 계정은 관리자 허용이 필요할 수 있습니다).'),
    card('Cursor', `<a href="cursor://anysphere.cursor-deeplink/mcp/install?name=pp-wbs&amp;config=${cursorCfg}">Cursor에서 설치</a> 또는 mcp.json에:`, pre(JSON.stringify({ mcpServers: { 'pp-wbs': { url: mcp } } }, null, 2))),
    card('VS Code · Zed · JetBrains · Gemini CLI', 'MCP 서버를 HTTP 주소로 추가합니다. Gemini CLI settings.json 예:', pre(JSON.stringify({ mcpServers: { 'pp-wbs': { httpUrl: mcp } } }, null, 2))),
    card('Zapier · n8n · Make', 'MCP 클라이언트 단계에 주소를 넣고 OAuth로 연결합니다.'),
    card('DeepSeek · Meta AI · Kimi 등 도구를 붙일 수 없는 곳', 'PP WBS 브라우저 확장으로 대화를 보내고, 확장 설정의 맞춤 지시문을 그 서비스의 사용자 지시에 넣으면 끝난 일이 원장 줄로 남습니다.'),
    card('함수 호출 앱 · 스크립트', `OpenAPI: <a href="${esc(u)}/openapi.json">${esc(u)}/openapi.json</a> (OAuth 인가 코드 + PKCE).`),
  ] : [
    card('Claude (web, desktop, mobile)', 'Settings → Connectors → Add custom connector, paste the MCP address below, then sign in and allow.'),
    card('Claude Code', 'In a terminal:', pre(`claude mcp add --transport http pp-wbs ${mcp}`)),
    card('ChatGPT', 'Turn on developer mode in the app and connector settings and add the MCP server address. Once listed in the directory, connect it from the app list.'),
    card('Grok', '<a href="https://grok.com/connectors" target="_blank" rel="noopener">grok.com/connectors</a> → New Connector → Custom, then paste the MCP address.'),
    card('Le Chat (Mistral) · Perplexity', 'Add a custom MCP connector with the address and sign in with OAuth (organisation accounts may need an admin to allow it).'),
    card('Cursor', `<a href="cursor://anysphere.cursor-deeplink/mcp/install?name=pp-wbs&amp;config=${cursorCfg}">Install in Cursor</a> or add to mcp.json:`, pre(JSON.stringify({ mcpServers: { 'pp-wbs': { url: mcp } } }, null, 2))),
    card('VS Code · Zed · JetBrains · Gemini CLI', 'Add an MCP server by its HTTP address. Gemini CLI settings.json example:', pre(JSON.stringify({ mcpServers: { 'pp-wbs': { httpUrl: mcp } } }, null, 2))),
    card('Zapier · n8n · Make', 'Use the MCP client step with the address and connect with OAuth.'),
    card('DeepSeek, Meta AI, Kimi and other sites without tools', 'Send conversations with the PP WBS browser extension; paste the instruction from its options into the site\'s custom instructions so finished work arrives as ledger lines.'),
    card('Function-calling apps and scripts', `OpenAPI: <a href="${esc(u)}/openapi.json">${esc(u)}/openapi.json</a> (OAuth authorization code with PKCE).`),
  ];
  const body = `<h1>PP WBS</h1>
<p class="sub">${ko ? `${esc(brand)} 계정 하나에 작업 원장 하나. 어느 에이전트에서든 같은 원장에 기록하고 읽습니다.` : `One work ledger per ${esc(brand)} account, written and read by every agent you use.`}</p>
<div class="url"><b>MCP</b><code>${esc(mcp)}</code></div>
<h2>${ko ? '연결하기' : 'Connect'}</h2>${cards.join('')}
<h2>${ko ? '보안' : 'Security'}</h2>
<p>${ko ? '연결은 OAuth 2.1(PKCE)로만 하고, 앱마다 필요한 권한만 받습니다. 원장 행·이력·받은 편지함은 계정마다 다른 키로 암호화되어 저장되고, 그 키는 클라우드 키 관리 서비스가 감쌉니다. 연결은 각 앱의 커넥터 설정에서 언제든 끊을 수 있습니다.'
    : 'Connections use OAuth 2.1 with PKCE and only the access each app asks for. Ledger rows, history and inbox items are encrypted with a key of your own account, wrapped by a cloud key management service. Disconnect any app from its connector settings at any time.'}</p>
<p class="foot"><a href="${esc(u)}/privacy">${ko ? '개인정보 처리 안내' : 'Privacy notice'}</a>${cfg.supportEmail ? ` · ${ko ? '문의' : 'Contact'}: ${esc(cfg.supportEmail)}` : ''}${cfg.host.termsUrl ? ` · <a href="${esc(cfg.host.termsUrl)}">${ko ? '이용약관' : 'Terms'}</a>` : ''}</p>`;
  return page(lang, 'PP WBS', body);
}

/** What is stored, how it is protected, how long it is kept, and the Chrome Web Store Limited Use statement. */
export function privacyPage(cfg: Config, lang: 'ko' | 'en'): string {
  const ko = lang === 'ko', host = cfg.host.sessionUrl ? cfg.host.name : '';
  const items = ko ? [
    ['무엇을 저장하나', '작업 원장(작업 행, 날짜, 상태, 근거 표시), 그 변경 이력, 받은 편지함 항목(브라우저 확장이나 에이전트가 보낸 대화·검색어·메모), 연결된 앱의 등록 정보와 토큰의 해시값.'],
    ['어떻게 보호하나', '계정마다 무작위 256비트 데이터 키를 만들고, 그 키는 클라우드 KMS 키로만 감싼 채 보관합니다. 원장 행·이력·받은 편지함·저장된 자격 증명은 그 키로 AES-256-GCM 암호화하고 계정과 위치에 묶습니다. 데이터베이스 사본이나 백업만으로는 읽을 수 없습니다.'],
    ['누가 읽나', '내가 OAuth로 허용한 앱이 그 권한 범위 안에서만 읽고 씁니다. 운영자는 법적 의무나 보안 사고 대응, 내가 요청한 지원 외에는 내용을 열람하지 않습니다.'],
    ['얼마나 보관하나', '원장은 내가 지울 때까지 보관합니다. 처리된 받은 편지함 항목은 30일 뒤 지워집니다. 계정을 삭제하면 데이터 키부터 지워 모든 사본을 읽을 수 없게 한 뒤 문서를 지웁니다.'],
    ...(host ? [['회원 계정', `연결을 허용하면 ${host} 계정으로 로그인되고, 처음이면 ${host} 회원으로 가입됩니다. ${host}의 개인정보처리방침이 함께 적용됩니다.`]] : []),
    ['브라우저 확장', '확장은 내가 누를 때만 열린 탭의 대화를, 내가 켰을 때만 Google 검색어와 시각을 내 계정으로 보냅니다. 브라우저 확장에서 받은 정보의 사용은 Chrome 웹 스토어 사용자 데이터 정책(제한적 사용 요건 포함)을 따릅니다. 광고, 판매, 신용 평가에 쓰지 않습니다.'],
  ] : [
    ['What is stored', 'Your work ledger (task rows, dates, status, evidence pointers), its change history, inbox items (conversations, search queries or notes sent by the browser extension or an agent), and the registrations of connected apps with hashes of their tokens.'],
    ['How it is protected', 'Each account gets a random 256-bit data key, kept only wrapped by a cloud KMS key. Ledger rows, history, inbox items and stored credentials are encrypted with it (AES-256-GCM), each bound to its account and place. A database copy or backup alone cannot be read.'],
    ['Who reads it', 'Only the apps you allowed through OAuth, within the access you granted. The operator does not look at content except for legal obligations, security incidents or support you ask for.'],
    ['How long it is kept', 'The ledger stays until you delete it. Processed inbox items are deleted after 30 days. Deleting your account deletes its data key first, which makes every copy unreadable, and then the documents.'],
    ...(host ? [['Your account', `Allowing a connection signs you in with your ${host} account and, the first time, makes you a ${host} member; ${host}'s privacy policy applies as well.`]] : []),
    ['Browser extension', 'The extension sends the conversation on the open tab only when you click, and Google search queries with their time only when you switch that on, to your own account. The use of information received from the browser extension adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements. It is never used for advertising, sold, or used to determine creditworthiness.'],
  ];
  const body = `<h1>${ko ? 'PP WBS 개인정보 처리 안내' : 'PP WBS privacy notice'}</h1>
<p class="sub">${ko ? '이 서비스가 무엇을 저장하고 어떻게 보호하는지.' : 'What this service stores and how it is protected.'}</p>
${items.map(([h, t]) => `<div class="card"><h3>${esc(h)}</h3><p>${esc(t)}</p></div>`).join('')}
<p class="foot">${cfg.host.privacyUrl ? `<a href="${esc(cfg.host.privacyUrl)}">${ko ? `${esc(cfg.host.name)} 개인정보처리방침` : `${esc(cfg.host.name)} privacy policy`}</a>` : ''}${cfg.supportEmail ? ` · ${ko ? '문의' : 'Contact'}: ${esc(cfg.supportEmail)}` : ''}</p>`;
  return page(lang, ko ? 'PP WBS 개인정보 처리 안내' : 'PP WBS privacy notice', body);
}

// Options: the hub URL, sign-in (here, because a tab survives the sign-in window), the search opt-in and the instruction text.
import { api, hubUrl, setHub, signIn, signOut, signedIn, BUILD_HUB } from './lib.js';
const $ = id => document.getElementById(id);

const INSTR = {
  ko: `내가 이 대화에서 구체적인 결과(문서·코드·결정·제출·신청·처리)를 끝내면, 답변 맨 끝에 결과마다 아래 형식의 줄을 한 줄씩 덧붙여 줘. 줄 앞뒤에 다른 말은 붙이지 마.
PP-WBS-RECORD {"package":"<중분류, 예: 4.3 서비스 개발>","task":"<무엇을 만들었거나 정했는지, 숫자 포함 한 문장>","start":"<YYYY-MM-DD>","status":"완료"}
진행 중이면 status를 "진행 중", 다른 사람을 기다리면 "대기·심사"로 써. 금액(급여·장학금·상금·송금·자산), 건강, 연애·관계, 계좌 정보, 다른 사람의 개인 연락처는 넣지 마.`,
  en: `When I finish something concrete in this conversation (a document, code, a decision, a submission, an application), add one line per result at the very end of your answer, in exactly this form and with nothing around it:
PP-WBS-RECORD {"package":"<work package, e.g. 3.1 App launch>","task":"<what was produced or decided, one sentence with numbers>","start":"<YYYY-MM-DD>","status":"완료"}
Use "진행 중" for in progress and "대기·심사" when waiting on someone else. Leave out amounts of pay, prizes or transfers, health, relationships, bank details and other people's contact details.`,
};
const lang = (navigator.language || 'en').startsWith('ko') ? 'ko' : 'en';
$('instr').value = INSTR[lang];

async function refresh() {
  const hub = await hubUrl();
  $('hub').value = hub; $('hub').readOnly = !!BUILD_HUB && hub === BUILD_HUB;
  const ok = await signedIn();
  $('state').textContent = ok ? `로그인됨 · ${new URL(hub).host}` : hub ? '로그인 전' : '허브 주소가 없습니다';
  $('in').hidden = ok; $('out').hidden = !ok;
  const { searchOn, pending = [] } = await chrome.storage.local.get(['searchOn', 'pending']);
  $('search').checked = !!searchOn; $('pending').textContent = `대기 중 ${pending.length}개`;
}
$('save').onclick = async () => { try { await setHub($('hub').value.trim()); await refresh(); } catch (e) { $('state').textContent = String(e.message || e); } };
$('in').onclick = async () => { try { if ($('hub').value.trim() && $('hub').value.trim() !== await hubUrl()) await setHub($('hub').value.trim()); await signIn(); } catch (e) { $('state').textContent = String(e.message || e); } refresh(); };
$('out').onclick = async () => { await signOut(); refresh(); };
$('search').onchange = async () => {
  if ($('search').checked) {   // asks for google.com only when switched on; the content script is registered by the service worker
    const ok = await chrome.permissions.request({ origins: ['https://www.google.com/*'] });
    if (!ok) { $('search').checked = false; return; }
  } else await chrome.permissions.remove({ origins: ['https://www.google.com/*'] }).catch(() => {});
  await chrome.storage.local.set({ searchOn: $('search').checked });
};
$('clear').onclick = async () => { await chrome.storage.local.set({ pending: [] }); refresh(); };
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('instr').value); $('copied').textContent = '복사했습니다'; }
  catch { $('instr').select(); $('copied').textContent = '선택했습니다. Ctrl+C로 복사하세요'; }
};
// Google Takeout "My Activity" (JSON): search entries carry the results URL, whose q parameter is the query in any language
$('takeout').onchange = async () => {
  const f = $('takeout').files[0]; if (!f) return;
  try {
    const all = JSON.parse(await f.text());
    const items = (Array.isArray(all) ? all : []).map(e => {
      try { const u = new URL(e.titleUrl || ''); const q = /(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/search' && u.searchParams.get('q');
        return q && e.time ? { kind: 'search', source: 'takeout', at: String(e.time).slice(0, 25), title: q.slice(0, 300), url: `https://www.google.com/search?q=${encodeURIComponent(q)}`, text: '' } : null; } catch { return null; }
    }).filter(Boolean);
    if (!items.length) { $('tk').textContent = '검색 기록을 찾지 못했습니다. 검색 폴더의 MyActivity.json인지 확인하세요.'; return; }
    let added = 0;
    for (let i = 0; i < items.length; i += 100) {
      const r = await api('/inbox', 'POST', { items: items.slice(i, i + 100) });
      if (!r.ok) throw new Error(r.body.message || r.body.error || `inbox ${r.status}`);
      added += r.body.added; $('tk').textContent = `${Math.min(i + 100, items.length)} / ${items.length}`;
    }
    $('tk').textContent = `검색어 ${items.length}개 중 새로 ${added}개를 보냈습니다.`;
  } catch (e) { $('tk').textContent = String(e.message || e); }
};
refresh();

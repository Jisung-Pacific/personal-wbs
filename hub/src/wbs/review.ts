// Mutual review, once a quarter (execution WBS 4.4). The strategy: "상호 리뷰(360) — 협업, 의도 정렬, 성향 — 분기 —
// 에이전트가 작업 근거를 붙인 질문으로 진행하고 결과는 대칭 공개", and "평가는 모두가 같은 기준으로 받는다 … 순위표와 자동
// 점수는 두지 않는다".
//
// An owner opens the quarter's round; the owners and members at that moment take part, and everyone gets the same
// questions. Each writes a self-review and a review of every other participant. The questions ask about the work — what
// someone made and how it served the team's intents, one thing to keep doing and one to change, each with something that
// actually happened, and where their direction could go next — and the hub attaches the evidence beside them: the rows
// the person shared with the team in the quarter (with the plan item and intent each serves), the plan items they carry,
// last quarter's goals and, where cards are visible to the reader, their direction. Answers may cite that evidence.
// There are no ratings, scores or rankings.
//
// Nothing is shown to anyone but its writer until the round is released: when everyone is done, or once the due date has
// passed. Disclosure is then symmetric: one reads a teammate's review of oneself only if one wrote a review of that
// teammate, and teammates' self-reviews, replies and goals only if one wrote one's own self-review; a review between two
// other people is never shown to anyone else. After release each participant may reply to the reviews about them and set
// up to three goals for the next quarter, which the next round shows beside their self-review.
//
// Why so: multisource feedback improves performance little on average, and mostly when recipients see a need to change,
// set goals and act on them (Smither, London & Reilly, 2005, Personnel Psychology 58(1), 33–66: 24 longitudinal
// studies); feedback that turns attention to the self rather than the task often lowers performance (Kluger & DeNisi,
// 1996, Psychological Bulletin 119(2), 254–284). A team in employee mode runs without reviews, as without cards: consent
// and purpose there need the adoption guide (execution WBS 5.2) first.
import { z } from 'zod';
import type { Review, ReviewAnswer, ReviewReply, ReviewRound, SharedWork, Store } from '../store/types.js';
import { LedgerError } from './service.js';
import { callerUid, type Caller, type Relation } from './access.js';
import type { Spaces } from './spaces.js';
import type { Views } from './views.js';
import type { Cards } from './cards.js';
import { intentOf } from './plan.js';
import { todayKst } from './model.js';

const DAY = 864e5;
const ms = (d: string) => Date.parse(d + 'T00:00:00Z');
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const kst = (t: number) => ymd(t + 9 * 3600e3);
const full = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
/** Rounds are kept a year (the four quarters before the current one), then the weekly run removes them. */
export const KEEP_QUARTERS = 4;
export const DUE_DAYS = 14, MAX_DUE_DAYS = 30, MAX_GOALS = 3, MIN_ANSWER = 10, MAX_ANSWER = 1200;

/** The first and last day of a quarter id (YYYY-Qn). */
export function quarterRange(id: string) {
  const m = /^(\d{4})-Q([1-4])$/.exec(id);
  if (!m) throw new LedgerError('invalid', 'A quarter is YYYY-Qn, e.g. 2026-Q4');
  const y = +m[1], q = +m[2];
  return { id, from: ymd(Date.UTC(y, 3 * q - 3, 1)), to: ymd(Date.UTC(y, 3 * q, 0)) };
}
/** The calendar quarter a date falls in. */
export const quarterOf = (day: string) => quarterRange(`${day.slice(0, 4)}-Q${Math.floor((+day.slice(5, 7) - 1) / 3) + 1}`);
/** The quarter before. */
export const prevQuarter = (id: string) => quarterOf(ymd(ms(quarterRange(id).from) - DAY)).id;

export interface Question { id: string; area: 'work' | 'intent' | 'collab' | 'direction'; required: boolean; ko: string; en: string }
/** The self-review: one's own quarter, against the team's intents and one's own goals and direction. */
export const SELF_QUESTIONS: readonly Question[] = [
  { id: 's_work', area: 'work', required: true,
    ko: '이번 분기 내 산출물 가운데 팀에 가장 쓸모 있었던 것 두세 개를 근거에서 골라, 무엇이 달라졌는지 적어 주세요.',
    en: 'Pick the two or three of your outputs this quarter that were most useful to the team, from the evidence, and say what changed because of them.' },
  { id: 's_intent', area: 'intent', required: true,
    ko: '내 작업이 팀 의도에서 벗어난 곳이 있었나요? 다음 분기에 더 힘을 실을 의도는 무엇인가요?',
    en: 'Where did your work drift from the team\'s intents? Which intent will you put more into next quarter?' },
  { id: 's_collab', area: 'collab', required: false,
    ko: '막혔거나 도움을 받은 일은 무엇이었고, 팀이 무엇을 바꾸면 더 빨랐을까요?',
    en: 'What blocked you or what help did you get, and what could the team change to make it faster?' },
  { id: 's_direction', area: 'direction', required: false,
    ko: '지난 분기 목표와 내 방향(1년 뒤 역할·키우고 싶은 것)에 비춰, 이번 분기는 어디까지 왔나요?',
    en: 'Against last quarter\'s goals and your direction (the role in a year, what you want to grow), where did this quarter get you?' },
];
/** A review of a teammate: the work and the intents it served, one behaviour to keep and one to change, each with a
 *  real example, and one next step toward their direction. No ratings. */
export const PEER_QUESTIONS: readonly Question[] = [
  { id: 'p_work', area: 'work', required: true,
    ko: '이 사람의 이번 분기 산출물 가운데 팀 의도에 가장 도움이 된 것은 무엇이고, 어떤 점에서 그랬나요? 근거에서 골라 적어 주세요.',
    en: 'Which of this person\'s outputs this quarter served the team\'s intents best, and how? Pick from the evidence.' },
  { id: 'p_keep', area: 'collab', required: true,
    ko: '함께 일하며 계속해 주었으면 하는 행동 하나를, 실제로 있었던 일로 적어 주세요.',
    en: 'One thing you want them to keep doing when working together, told through something that actually happened.' },
  { id: 'p_change', area: 'collab', required: true,
    ko: '바꾸면 팀이 더 나아질 행동 하나를, 실제로 있었던 일과 다음에 해 볼 방법으로 적어 주세요.',
    en: 'One thing that would make the team better if they changed it: what happened, and what they could try next time.' },
  { id: 'p_direction', area: 'direction', required: false,
    ko: '이 사람의 방향(1년 뒤 역할·키우고 싶은 것)을 위해 다음 분기에 맡아 볼 만한 일을 하나 제안해 주세요.',
    en: 'Suggest one piece of work they could take on next quarter toward their direction (the role in a year, what they want to grow).' },
];
const questionsFor = (self: boolean) => self ? SELF_QUESTIONS : PEER_QUESTIONS;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const ReviewOpenInput = z.object({
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/).optional().describe('YYYY-Qn: the current quarter (default), or the one before within a month of its end'),
  due: date.optional().describe(`The last day to write reviews; default ${DUE_DAYS} days from today, at most ${MAX_DUE_DAYS}`),
});
export const ReviewSubmitInput = z.object({
  about: z.string().min(1).max(128).describe('"self" for the self-review, or a participant\'s account id from the round'),
  answers: z.array(z.object({
    q: z.string().describe('The question id (s_… for the self-review, p_… for a teammate)'),
    text: z.string().max(MAX_ANSWER).describe('The person\'s own words'),
    refs: z.array(z.string()).max(5).optional().describe('Evidence the answer rests on: refs from the evidence list'),
  })).min(1).max(8),
});
export const ReviewReplyInput = z.object({
  text: z.string().max(1500).optional().describe('The person\'s reply to the reviews about them'),
  goals: z.array(z.string().min(1).max(200)).max(MAX_GOALS).optional().describe(`Up to ${MAX_GOALS} goals for the next quarter`),
});

/** The evidence attached to one participant's questions, as the reader may see it. */
export interface Evidence {
  work: { ref: string; plan: string; scope: string; intent: string; title: string; status: string; start: string; end: string; label: string }[];
  items: { ref: string; code: string; scope: string; status: string; due: string; label: string }[];
  intents: { rank: number; why: string; rows: number }[];
  off_intent_rows: number;
  goals: string[] | null;
  direction: { role: string; grow: string; ask: string } | null;
}

export class Reviews {
  /** `today`: the date in Korea (KST) the hub works in; tests fix it. */
  constructor(private store: Store, private spaces: Spaces, private views?: Views, cards?: Cards, private today: () => string = todayKst) {
    const prev = spaces.left;   // leaving a team (or becoming a guest) takes one out of its rounds, with everything by or about one
    spaces.left = async (space, uid) => { await prev?.(space, uid); await this.drop(space, uid); };
    if (cards) {   // employee mode switches reviews off with the cards, and removes every round
      const before = cards.employee;
      cards.employee = async (space, on) => { await before?.(space, on); if (on) for (const r of await this.store.reviewRounds(space)) await this.store.removeReviewRound(space, r.id); };
    }
  }

  private async name(uid: string) { return (await this.store.secret<{ name?: string }>(uid, 'profile'))?.name || `계정 ${uid.slice(0, 8)}`; }

  /** The round a call means: the quarter given, else the latest. */
  private async round(space: string, quarter?: string) {
    const rounds = await this.store.reviewRounds(space);
    if (quarter) { const q = quarterRange(quarter).id; return rounds.find(r => r.id === q) ?? null; }
    return rounds.length ? rounds[rounds.length - 1] : null;
  }

  /** Releases a round once everyone is done or its due date has passed (idempotent). */
  private async settle(space: string, r: ReviewRound, reviews: Review[], today: string) {
    if (r.released) return r;
    const done = r.participants.every(u => this.doneBy(r, reviews, u));
    if (!done && today <= r.due) return r;
    const next = { ...r, released: Date.now() };
    await this.store.putReviewRound(space, next);
    return next;
  }
  private doneBy = (r: ReviewRound, reviews: Review[], uid: string) => r.participants.every(p => reviews.some(v => v.by === uid && v.about === p));

  /** Opens the quarter's round: an owner, in person or through their agent; the owners and members now take part. */
  async open(caller: Caller, space: string, raw: z.input<typeof ReviewOpenInput> = {}) {
    const input = ReviewOpenInput.parse(raw ?? {});
    await this.spaces.enter(caller, space, 'review.open');
    if (await this.store.cardsOff(space)) throw new LedgerError('forbidden', 'This team runs in employee mode: no mutual reviews (see the adoption guide)');
    const today = this.today(), cur = quarterOf(today), q = input.quarter ? quarterRange(input.quarter) : cur, prev = quarterRange(prevQuarter(cur.id));
    if (q.id !== cur.id && !(q.id === prev.id && ms(today) - ms(prev.to) <= 31 * DAY)) throw new LedgerError('invalid', 'Open the current quarter, or the one before within a month of its end');
    if ((await this.store.reviewRounds(space)).some(r => r.id === q.id)) throw new LedgerError('duplicate', `The ${q.id} round is already open`);
    const participants = (await this.store.members(space)).filter(m => m.role !== 'guest').map(m => m.uid).sort();
    if (participants.length < 2) throw new LedgerError('invalid', 'A review needs at least two people: the owner and a member');
    const due = input.due ?? ymd(ms(today) + DUE_DAYS * DAY);
    if (due <= today || ms(due) - ms(today) > MAX_DUE_DAYS * DAY) throw new LedgerError('invalid', `The due date falls within the next ${MAX_DUE_DAYS} days`);
    const r: ReviewRound = { id: q.id, from: q.from, to: q.to, opened: Date.now(), by: callerUid(caller) ?? '', due, participants, released: null };
    await this.store.putReviewRound(space, r);
    return { space, quarter: r.id, from: r.from, to: r.to, due, participants: participants.length, opened: true };
  }

  /** The evidence beside one participant's questions, as `reader` may see it: their rows shared with the team in the
   *  quarter, the plan items they carry, their work per intent, last quarter's goals and their direction where visible. */
  private async evidence(space: string, r: ReviewRound, reader: string, about: string): Promise<Evidence> {
    const [items, work, intents, off] = await Promise.all([this.store.plan(space), this.store.shared(space), this.store.intents(space), this.store.cardsOff(space)]);
    const byKey = new Map(items.map(p => [`${p.year}:${p.code}`, p])), iOf = intentOf(items), byId = new Map(intents.map(i => [i.id, i]));
    const within = (w: SharedWork) => {
      const f = w.fields;
      if (full(f.start)) return f.start! <= r.to && (!full(f.end) || f.end! >= r.from);
      if (full(f.last_progress)) return f.last_progress! >= r.from && f.last_progress! <= r.to;
      const at = kst(w.at); return at >= r.from && at <= r.to;
    };
    const rows = work.filter(w => w.uid === about && within(w)).map(w => {
      const p = byKey.get(w.plan), f = w.fields, intent = byId.get(iOf(p));
      const code = w.plan.split(':')[1] ?? w.plan, scope = p?.scope ?? '';
      return { ref: w.id, plan: code, scope, intent: intent ? intent.why : '', title: f.title ?? '', status: f.status ?? '', start: f.start ?? '', end: f.end ?? '',
        label: `${code} ${scope}${f.title ? ` — ${f.title}` : ''}${f.status ? ` · ${f.status}` : ''}` };
    }).sort((a, b) => (a.end || a.start).localeCompare(b.end || b.start));
    const name = (await this.store.secret<{ name?: string }>(about, 'profile'))?.name;
    const carried = items.filter(p => p.status !== '백로그' && p.owners.some(o => o === about || (!!name && o === name)))
      .slice(0, 12).map(p => ({ ref: `item:${p.year}:${p.code}`, code: p.code, scope: p.scope, status: p.status, due: p.due, label: `${p.code} ${p.scope} · ${p.status}` }));
    const count = new Map<string, number>(); let offIntent = 0;
    for (const w of work.filter(x => x.uid === about && within(x))) { const i = iOf(byKey.get(w.plan)); if (i && byId.has(i)) count.set(i, (count.get(i) ?? 0) + 1); else offIntent++; }
    const per = [...count].map(([id, n]) => ({ rank: byId.get(id)!.rank, why: byId.get(id)!.why, rows: n })).sort((a, b) => a.rank - b.rank);
    // last quarter's goals: one's own, or a teammate's where one could read them then (one wrote one's self-review)
    let goals: string[] | null = null;
    const prev = (await this.store.reviewRounds(space)).find(x => x.id === prevQuarter(r.id));
    if (prev?.released && prev.participants.includes(about)) {
      const g = (await this.store.replies(space, prev.id)).find(x => x.by === about)?.goals ?? [];
      const sees = reader === about || (prev.participants.includes(reader) && (await this.store.reviews(space, prev.id)).some(v => v.by === reader && v.about === reader));
      if (sees) goals = g;
    }
    // the direction from their card, by the cards' own symmetry (one sees it while one's own card shows a direction)
    let direction: Evidence['direction'] = null;
    if (!off) {
      const cards = await this.store.cards(space), theirs = cards.find(c => c.uid === about), mine = cards.find(c => c.uid === reader);
      if (theirs?.direction && theirs.sections.includes('direction') && (reader === about || mine?.sections.includes('direction'))) direction = theirs.direction;
    }
    return { work: rows, items: carried, intents: per, off_intent_rows: offIntent, goals, direction };
  }

  private relation = async (caller: Caller, space: string) => (await this.spaces.enter(caller, space, 'review.read')).relation as Relation;

  /** The round as the caller may see it. Before release: its progress and what the caller wrote. After release: the
   *  reviews about the caller from the teammates the caller reviewed, what the caller wrote, and — if the caller wrote a
   *  self-review — the teammates' self-reviews, replies and goals. The team's agent sees the progress only. */
  async get(caller: Caller, space: string, quarter?: string) {
    await this.relation(caller, space);
    const employee = await this.store.cardsOff(space), questions = { self: SELF_QUESTIONS, peer: PEER_QUESTIONS };
    let r = await this.round(space, quarter);
    if (!r) return { space, quarter: quarter ?? null, status: 'none' as const, employee_mode: employee, questions,
      note: employee ? '이 팀은 직원 모드라 상호 리뷰를 쓰지 않습니다.' : '아직 연 리뷰가 없습니다. 소유자가 분기 리뷰를 엽니다.' };
    const today = this.today(), reviews = await this.store.reviews(space, r.id);
    r = await this.settle(space, r, reviews, today);
    const counts = { participants: r.participants.length, done: r.participants.filter(u => this.doneBy(r!, reviews, u)).length };
    const base = { space, quarter: r.id, from: r.from, to: r.to, status: r.released ? 'released' as const : 'open' as const, opened: kst(r.opened), due: r.due,
      released: r.released ? kst(r.released) : null, counts };
    if (caller.kind === 'team_agent') return base;   // how far the round is; nothing anyone wrote
    const me = callerUid(caller)!, isIn = r.participants.includes(me), mine = reviews.filter(v => v.by === me);
    const names = new Map(await Promise.all(r.participants.map(async u => [u, await this.name(u)] as const)));
    const ask = (self: boolean) => new Map(questionsFor(self).map(q => [q.id, q.ko]));
    const show = (v: Review) => v.answers.map(a => ({ q: a.q, question: ask(v.by === v.about).get(a.q) ?? a.q, text: a.text, refs: a.refs }));
    const out = { ...base, participant: isIn, questions,
      participants: r.participants.map(u => ({ uid: u, name: names.get(u)!, me: u === me, written_by_me: mine.some(v => v.about === u) })),
      todo: isIn && !r.released ? r.participants.filter(u => !mine.some(v => v.about === u)).map(u => u === me ? 'self' : u) : [] };
    if (!r.released) return { ...out, results: null, written: mine.map(v => ({ about: v.about === me ? 'self' : v.about, answers: show(v), via: v.via, at: v.at })),
      note: '모두 마치거나 마감일이 지나면 공개됩니다. 그전에는 각자 쓴 것만 보입니다.' };
    if (!isIn) return { ...out, results: null, note: '이 분기 리뷰가 열린 뒤에 합류해 참여하지 않았습니다.' };
    const replies = await this.store.replies(space, r.id), wrote = new Set(mine.map(v => v.about)), self = wrote.has(me);
    const aboutMe = reviews.filter(v => v.about === me && v.by !== me);
    const reply = (u: string) => { const x = replies.find(y => y.by === u); return x ? { text: x.text, goals: x.goals, at: x.at } : null; };
    return { ...out, results: {
      about_me: aboutMe.filter(v => wrote.has(v.by)).map(v => ({ by: { uid: v.by, name: names.get(v.by)! }, via: v.via, answers: show(v) })),
      hidden_about_me: aboutMe.filter(v => !wrote.has(v.by)).length,
      written: mine.map(v => ({ about: v.about === me ? 'self' : v.about, name: names.get(v.about)!, answers: show(v) })),
      selves: self ? r.participants.filter(u => u !== me).map(u => {
        const s = reviews.find(v => v.by === u && v.about === u);
        return { by: { uid: u, name: names.get(u)! }, self: s ? show(s) : null, reply: reply(u) };
      }).filter(x => x.self || x.reply) : [],
      my_reply: reply(me),
    }, note: '내가 리뷰를 써 준 사람의 리뷰만 받아 보고, 내 자기 리뷰를 쓴 경우에만 다른 사람의 자기 리뷰와 목표가 보입니다. 두 사람 사이의 리뷰는 다른 사람에게 보이지 않습니다.' };
  }

  /** The questions about one participant with the evidence attached: what an agent asks the person in turn, and what the
   *  hub's page shows. Reading a teammate's rows or card direction here is noted in their view log. */
  async questions(caller: Caller, space: string, about: string, quarter?: string) {
    const relation = await this.relation(caller, space), me = callerUid(caller);
    if (!me) throw new LedgerError('forbidden', 'Reviews are written by people (through their own agents), not by the team\'s agent');
    let r = await this.round(space, quarter);
    if (!r) throw new LedgerError('not_found', 'No review round is open in this team');
    r = await this.settle(space, r, await this.store.reviews(space, r.id), this.today());
    if (r.released) throw new LedgerError('invalid', `The ${r.id} round is released; its reviews no longer change`);
    if (!r.participants.includes(me)) throw new LedgerError('forbidden', 'You are not taking part in this round (it opened before you joined)');
    const subject = about === 'self' ? me : about;
    if (!r.participants.includes(subject)) throw new LedgerError('not_found', 'Not a participant of this round; see participants in wbs_review');
    const ev = await this.evidence(space, r, me, subject);
    if (subject !== me) {
      if (ev.work.length) await this.views?.saw(caller, relation, space, new Map([[subject, ev.work.length]]), 'work');
      if (ev.direction) await this.views?.saw(caller, relation, space, new Map([[subject, 1]]), 'card');
    }
    const prior = (await this.store.reviews(space, r.id)).find(v => v.by === me && v.about === subject);
    return { space, quarter: r.id, from: r.from, to: r.to, due: r.due, about: { uid: subject, name: await this.name(subject), self: subject === me },
      questions: questionsFor(subject === me).map(q => ({ id: q.id, area: q.area, required: q.required, text: q.ko, en: q.en })),
      evidence: ev, answers: prior?.answers ?? null,
      how: 'Ask the person each question in turn with the evidence beside it, and record only their own words (wbs_review_put, action submit). Required questions need at least a sentence; answers may cite evidence by ref.' };
  }

  /** The caller's answers about one participant ("self" for the self-review); revisable until the round is released. */
  async submit(caller: Caller, space: string, raw: z.input<typeof ReviewSubmitInput>, quarter?: string) {
    const input = ReviewSubmitInput.parse(raw);
    await this.spaces.enter(caller, space, 'review.write');
    const me = callerUid(caller)!, today = this.today();
    let r = await this.round(space, quarter);
    if (!r) throw new LedgerError('not_found', 'No review round is open in this team');
    r = await this.settle(space, r, await this.store.reviews(space, r.id), today);
    if (r.released) throw new LedgerError('invalid', `The ${r.id} round is released; its reviews no longer change`);
    if (!r.participants.includes(me)) throw new LedgerError('forbidden', 'You are not taking part in this round (it opened before you joined)');
    const subject = input.about === 'self' ? me : input.about;
    if (!r.participants.includes(subject)) throw new LedgerError('not_found', 'Not a participant of this round');
    const qs = questionsFor(subject === me), ids = new Set(qs.map(q => q.id));
    const ev = await this.evidence(space, r, me, subject), known = new Map([...ev.work, ...ev.items].map(x => [x.ref, x.label]));
    const seen = new Set<string>(), answers: ReviewAnswer[] = [];
    for (const a of input.answers) {
      if (!ids.has(a.q)) throw new LedgerError('invalid', `No question ${a.q} here; the ${subject === me ? 'self-review' : 'review of a teammate'} asks ${[...ids].join(', ')}`);
      if (seen.has(a.q)) throw new LedgerError('invalid', `${a.q} is answered twice`);
      seen.add(a.q);
      const text = a.text.trim(), refs = [...new Set(a.refs ?? [])];
      const bad = refs.filter(x => !known.has(x));
      if (bad.length) throw new LedgerError('invalid', `Not in the evidence for this person: ${bad.join(', ')}`);
      if (text) answers.push({ q: a.q, text, refs: refs.map(x => ({ ref: x, label: known.get(x)! })) });
    }
    const short = qs.filter(q => q.required && !answers.some(a => a.q === q.id && a.text.length >= MIN_ANSWER));
    if (short.length) throw new LedgerError('invalid', `Answer ${short.map(q => q.id).join(', ')} in at least a sentence (${MIN_ANSWER}+ characters), in the person's own words`);
    await this.store.putReview(space, { round: r.id, by: me, about: subject, answers: qs.flatMap(q => answers.filter(a => a.q === q.id)),
      via: caller.kind === 'agent' ? caller.client : '', at: Date.now() });
    const reviews = await this.store.reviews(space, r.id), after = await this.settle(space, r, reviews, today), mine = reviews.filter(v => v.by === me);
    return { space, quarter: r.id, about: input.about === 'self' || subject === me ? 'self' : subject, saved: true, released: !!after.released,
      todo: after.released ? [] : r.participants.filter(u => !mine.some(v => v.about === u)).map(u => u === me ? 'self' : u) };
  }

  /** After release: the caller's reply to the reviews about them and up to three goals for the next quarter. */
  async reply(caller: Caller, space: string, raw: z.input<typeof ReviewReplyInput>, quarter?: string) {
    const input = ReviewReplyInput.parse(raw ?? {});
    await this.spaces.enter(caller, space, 'review.write');
    const me = callerUid(caller)!;
    let r = await this.round(space, quarter);
    if (!r) throw new LedgerError('not_found', 'No review round in this team');
    r = await this.settle(space, r, await this.store.reviews(space, r.id), this.today());
    if (!r.released) throw new LedgerError('invalid', 'Replies and goals open once the round is released');
    if (!r.participants.includes(me)) throw new LedgerError('forbidden', 'You did not take part in this round');
    if (input.text === undefined && input.goals === undefined) throw new LedgerError('invalid', 'Give a reply, goals, or both');
    const prev = (await this.store.replies(space, r.id)).find(x => x.by === me);
    const reply: ReviewReply = { round: r.id, by: me, text: (input.text ?? prev?.text ?? '').trim(), goals: (input.goals ?? prev?.goals ?? []).map(g => g.trim()).filter(Boolean), at: Date.now() };
    await this.store.putReply(space, reply);
    return { space, quarter: r.id, saved: true, text: reply.text, goals: reply.goals };
  }

  /** What a team screen shows of the latest round: its state and progress, and the caller's own part. */
  async summary(caller: Caller, space: string) {
    const g = await this.get(caller, space);
    if (g.status === 'none') return { status: 'none' as const, employee_mode: (g as { employee_mode: boolean }).employee_mode };
    const x = g as { quarter: string; status: 'open' | 'released'; due: string; released: string | null; counts: { participants: number; done: number }; participant?: boolean; todo?: string[];
      results?: { about_me: unknown[]; hidden_about_me: number } | null };
    return { quarter: x.quarter, status: x.status, due: x.due, released: x.released, counts: x.counts,
      ...(x.participant !== undefined ? { participant: x.participant, todo: x.todo?.length ?? 0 } : {}),
      ...(x.results ? { received: x.results.about_me.length, hidden: x.results.hidden_about_me } : {}) };
  }

  /** A person leaves a team or becomes a guest there: out of every round, with everything by or about them. */
  private async drop(space: string, uid: string) {
    for (const r of await this.store.reviewRounds(space)) {
      if (!r.participants.includes(uid)) continue;
      for (const v of await this.store.reviews(space, r.id)) if (v.by === uid || v.about === uid) await this.store.removeReview(space, r.id, v.by, v.about);
      await this.store.removeReply(space, r.id, uid);
      await this.store.putReviewRound(space, { ...r, participants: r.participants.filter(u => u !== uid) });
    }
  }

  /** The weekly run: releases rounds whose due date has passed and removes rounds older than four quarters. */
  async sweep(today = this.today()) {
    let cutoff = quarterOf(today).id;
    for (let i = 0; i < KEEP_QUARTERS; i++) cutoff = prevQuarter(cutoff);
    let released = 0, removed = 0;
    for (const id of await this.store.teamSpaceIds()) {
      for (const r of await this.store.reviewRounds(id)) {
        if (r.id < cutoff) { await this.store.removeReviewRound(id, r.id); removed++; continue; }
        if (!r.released && (await this.settle(id, r, await this.store.reviews(id, r.id), today)).released) released++;
      }
    }
    return { released, removed };
  }
}


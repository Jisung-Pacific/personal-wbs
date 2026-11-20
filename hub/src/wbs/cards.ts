// Work-style and direction cards (execution WBS 4.2; the strategy: "성향과 방향성은 서로 본다 … 카드마다 본인이 반론을
// 단다", "한 사람이 위에서 보면 감시가 되므로 반드시 대칭이어야 한다").
//
// A person answers a validated Big Five self-report once, in their own space (the scores are kept, the answers are not),
// and may publish a card to a team: the traits they choose and a short direction (the role they want in a year, what
// they want to grow, what they ask of the team). Disclosure is symmetric section by section: a person sees a section of
// the others' cards only while publishing that section themselves, so nobody looks at the team from above. Beside the
// self-report, a card carries work indicators inferred from the rows its person shared with that team — never from the
// personal ledger — marked as inferred, with the person's rebuttal shown next to them (the strategy: "성향은 추론
// 정보다. 본인이 자기 카드를 보고 반론을 단다").
//
// Cards are people's own act: publishing, withdrawing and reading go through a person's first-party session, not an
// agent (the role table: personal agents ✗), and the team's delegated agent may read them. Nothing here compares,
// ranks or totals people: no team averages, no order by score, and the cards are not an input to anything else in the
// hub (the strategy: "성향 지표를 인사 판단에 쓰는 기능은 만들지 않는다"). A team with employees switches cards off
// (employee mode), which removes every card at once. Leaving a team removes one's card there.
//
// Instrument: the Mini-IPIP — Donnellan, Oswald, Baird & Lucas (2006), "The Mini-IPIP scales: Tiny-yet-effective
// measures of the Big Five factors of personality", Psychological Assessment 18(2), 192–203 — twenty items drawn from
// the IPIP Big-Five factor markers (Goldberg, 1992, Psychological Assessment 4, 26–42). IPIP items are in the public
// domain ("one can copy, edit, translate, or use them for any purpose without asking permission", ipip.ori.org).
// Each trait is the sum of its four items on a 1–5 scale, reverse-keyed items as 6 − x (4–20). Reported coefficient
// alphas: E .77, A .70, C .69, N .68, I .65. Neuroticism is shown the other way round, as emotional stability (24 − N),
// the direction of Goldberg's original marker. Scores are raw sums: no Korean norms are applied and none are implied.
import { z } from 'zod';
import { CARD_SECTIONS, TRAITS, type Assessment, type Card, type CardSection, type SharedWork, type Store, type Trait } from '../store/types.js';
import { LedgerError } from './service.js';
import { callerUid, type Caller } from './access.js';
import type { Spaces } from './spaces.js';
import type { Views } from './views.js';

/** The twenty items in administration order with their trait and keying (+ scored as given, − as 6 − x). The Korean
 *  wording is a working translation; the IPIP's published Korean back-translation of the factor markers replaces it. */
export const MINI_IPIP: readonly { n: number; trait: Trait; plus: boolean; en: string; ko: string }[] = [
  { n: 1, trait: 'E', plus: true, en: 'Am the life of the party.', ko: '모임에서 분위기를 띄우는 편이다.' },
  { n: 2, trait: 'A', plus: true, en: "Sympathize with others' feelings.", ko: '다른 사람의 감정에 공감한다.' },
  { n: 3, trait: 'C', plus: true, en: 'Get chores done right away.', ko: '해야 할 일을 바로 처리한다.' },
  { n: 4, trait: 'N', plus: true, en: 'Have frequent mood swings.', ko: '기분이 자주 바뀐다.' },
  { n: 5, trait: 'I', plus: true, en: 'Have a vivid imagination.', ko: '상상력이 풍부하다.' },
  { n: 6, trait: 'E', plus: false, en: "Don't talk a lot.", ko: '말을 많이 하지 않는다.' },
  { n: 7, trait: 'A', plus: false, en: "Am not interested in other people's problems.", ko: '다른 사람의 문제에는 관심이 없다.' },
  { n: 8, trait: 'C', plus: false, en: 'Often forget to put things back in their proper place.', ko: '물건을 제자리에 두는 것을 자주 잊는다.' },
  { n: 9, trait: 'N', plus: false, en: 'Am relaxed most of the time.', ko: '대부분의 시간 동안 느긋하다.' },
  { n: 10, trait: 'I', plus: false, en: 'Am not interested in abstract ideas.', ko: '추상적인 생각에는 관심이 없다.' },
  { n: 11, trait: 'E', plus: true, en: 'Talk to a lot of different people at parties.', ko: '모임에서 여러 사람과 두루 이야기한다.' },
  { n: 12, trait: 'A', plus: true, en: "Feel others' emotions.", ko: '다른 사람의 감정을 함께 느낀다.' },
  { n: 13, trait: 'C', plus: true, en: 'Like order.', ko: '정돈된 것을 좋아한다.' },
  { n: 14, trait: 'N', plus: true, en: 'Get upset easily.', ko: '쉽게 언짢아진다.' },
  { n: 15, trait: 'I', plus: false, en: 'Have difficulty understanding abstract ideas.', ko: '추상적인 생각을 이해하기 어렵다.' },
  { n: 16, trait: 'E', plus: false, en: 'Keep in the background.', ko: '앞에 나서지 않고 뒤에 있는다.' },
  { n: 17, trait: 'A', plus: false, en: 'Am not really interested in others.', ko: '다른 사람에게 별 관심이 없다.' },
  { n: 18, trait: 'C', plus: false, en: 'Make a mess of things.', ko: '일을 엉망으로 만든다.' },
  { n: 19, trait: 'N', plus: false, en: 'Seldom feel blue.', ko: '우울한 기분이 드는 일이 드물다.' },
  { n: 20, trait: 'I', plus: false, en: 'Do not have a good imagination.', ko: '상상력이 좋은 편이 아니다.' },
];
export const SCALE = [
  { v: 1, en: 'Very inaccurate', ko: '전혀 아니다' }, { v: 2, en: 'Moderately inaccurate', ko: '대체로 아니다' },
  { v: 3, en: 'Neither accurate nor inaccurate', ko: '그저 그렇다' }, { v: 4, en: 'Moderately accurate', ko: '대체로 그렇다' },
  { v: 5, en: 'Very accurate', ko: '매우 그렇다' },
] as const;
export const INSTRUCTIONS = '앞으로 되고 싶은 모습이 아니라 지금 평소의 나를, 비슷한 나이의 아는 사람들과 견주어 솔직하게 고르세요. 정답은 없습니다.';
/** How each trait is shown: Neuroticism the other way round, as emotional stability. */
export const TRAIT_KO: Record<Trait, string> = { E: '외향성', A: '친화성', C: '성실성', N: '정서 안정성', I: '지성·상상력' };
export const ALPHA: Record<Trait, number> = { E: 0.77, A: 0.70, C: 0.69, N: 0.68, I: 0.65 };
const shown = (t: Trait, raw: number) => t === 'N' ? 24 - raw : raw;
/** Re-measure after half a year (the strategy: 합류 때, 반기). */
export const STALE_DAYS = 183;
/** By default a card shows four traits and the direction; emotional stability is added only by choice. */
export const DEFAULT_SECTIONS: CardSection[] = ['E', 'A', 'C', 'I', 'direction'];

/** The twenty answers, 1–5 each, in item order → the five sums (4–20). */
export function scoreMiniIpip(answers: number[]): Record<Trait, number> {
  if (answers.length !== MINI_IPIP.length || answers.some(a => !Number.isInteger(a) || a < 1 || a > 5)) throw new LedgerError('invalid', 'Twenty answers, each 1 to 5');
  const s = { E: 0, A: 0, C: 0, N: 0, I: 0 } as Record<Trait, number>;
  MINI_IPIP.forEach((it, i) => { s[it.trait] += it.plus ? answers[i] : 6 - answers[i]; });
  return s;
}

const text = (n: number) => z.string().trim().max(n);
export const CardInput = z.object({
  sections: z.array(z.enum(CARD_SECTIONS)).min(1).max(CARD_SECTIONS.length).optional().describe('What the card shows; default the four traits other than emotional stability, and the direction'),
  direction: z.object({ role: text(160), grow: text(160), ask: text(160) }).partial().optional(),
  rebuttal: z.object({ traits: text(300), work: text(300), direction: text(300) }).partial().optional(),
});

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

/** What the rows a person shared with this team suggest about how they work: inferred, and only from those rows. */
export function workIndicators(rows: SharedWork[]) {
  const f = rows.filter(w => !w.frozen).map(w => w.fields), done = f.filter(x => x.status === '완료');
  const lead = done.flatMap(x => x.start && x.end && /^\d{4}-\d{2}-\d{2}$/.test(x.start) && /^\d{4}-\d{2}-\d{2}$/.test(x.end) ? [days(x.start, x.end)] : []).filter(n => n >= 0);
  const due = done.filter(x => x.due && x.end), onTime = due.filter(x => String(x.end) <= String(x.due)).length;
  const wd = new Map<number, number>();
  for (const x of done) if (x.end && /^\d{4}-\d{2}-\d{2}$/.test(x.end)) { const d = new Date(x.end + 'T00:00:00Z').getUTCDay(); wd.set(d, (wd.get(d) ?? 0) + 1); }
  const top = [...wd].sort((a, b) => b[1] - a[1])[0], open = f.length - done.length, med = median(lead);
  const ind = { rows: f.length, done: done.length, open, median_days: med, on_time: due.length ? { kept: onTime, of: due.length } : null,
    usual_finish_day: top && done.length >= 3 && top[1] / done.length >= 0.4 ? WEEKDAY[top[0]] : null };
  const parts = [`공유 행 ${ind.rows} · 완료 ${ind.done} · 열린 행 ${open}`, med !== null ? `완료까지 중앙값 ${med}일` : '', ind.on_time ? `마감 지킴 ${onTime}/${due.length}` : '',
    ind.usual_finish_day ? `주로 ${ind.usual_finish_day}요일에 마침` : ''].filter(Boolean);
  return { ...ind, line: parts.join(' · '), inferred: true as const, basis: '이 팀에 공유한 행만' };
}

const isPerson = (c: Caller) => c.kind === 'person';

export class Cards {
  constructor(private store: Store, private spaces: Spaces, private views?: Views) {
    const prev = spaces.left;   // leaving a team (or becoming a guest) takes one's card off it
    spaces.left = async (space, uid) => { await prev?.(space, uid); await this.store.removeCard(space, uid); };
  }

  private person(caller: Caller) {
    if (!isPerson(caller)) throw new LedgerError('forbidden', 'Cards are a person\'s own act, in the hub\'s own pages; agents neither fill, publish nor read them');
    return callerUid(caller)!;
  }

  /** The questionnaire as the pages show it. */
  questionnaire() {
    return { instrument: 'mini-ipip-20' as const, instructions: INSTRUCTIONS, scale: SCALE, items: MINI_IPIP.map(i => ({ n: i.n, text: i.ko, en: i.en })),
      source: 'Donnellan, Oswald, Baird & Lucas (2006), Psychological Assessment 18(2), 192–203; IPIP (public domain)' };
  }

  /** Scores twenty answers and keeps the scores (not the answers) in the person's own space. */
  async assess(caller: Caller, answers: number[]) {
    const uid = this.person(caller), a: Assessment = { instrument: 'mini-ipip-20', at: Date.now(), scores: scoreMiniIpip(answers) };
    await this.store.putSecret(uid, 'big5', a);
    return { at: a.at, traits: traitView(a.scores) };
  }

  /** The person's own assessment and where they have published a card. */
  async mine(caller: Caller) {
    const uid = this.person(caller), a = await this.store.secret<Assessment>(uid, 'big5');
    return { assessment: a ? { at: a.at, stale: Date.now() - a.at > STALE_DAYS * 864e5, traits: traitView(a.scores) } : null };
  }

  /** Publishes (or updates) the person's card in a team: the chosen sections copied from their assessment, their
   *  direction and their rebuttals. Owners and members only, while the team has cards switched on. */
  async publish(caller: Caller, space: string, raw: z.input<typeof CardInput>) {
    const uid = this.person(caller), input = CardInput.parse(raw);
    await this.spaces.enter(caller, space, 'cards.publish');
    if (await this.store.cardsOff(space)) throw new LedgerError('forbidden', 'This team runs in employee mode: no cards');
    const a = await this.store.secret<Assessment>(uid, 'big5');
    const prev = (await this.store.cards(space)).find(c => c.uid === uid);
    const sections = [...new Set(input.sections ?? prev?.sections ?? DEFAULT_SECTIONS)].filter(s => CARD_SECTIONS.includes(s)) as CardSection[];
    const traits = sections.filter((s): s is Trait => (TRAITS as readonly string[]).includes(s));
    if (traits.length && !a) throw new LedgerError('invalid', 'Answer the twenty questions first: a card shows your own scores');
    const direction = { role: '', grow: '', ask: '', ...prev?.direction, ...input.direction };
    if (sections.includes('direction') && !direction.role && !direction.grow && !direction.ask) throw new LedgerError('invalid', 'Write at least one line of your direction, or leave the direction off the card');
    const now = Date.now(), card: Card = {
      uid, sections, scores: Object.fromEntries(traits.map(t => [t, a!.scores[t]])), measured: a?.at ?? 0,
      ...(sections.includes('direction') ? { direction } : {}),
      rebuttal: { ...prev?.rebuttal, ...input.rebuttal }, published: prev?.published ?? now, updated: now,
    };
    await this.store.putCard(space, card);
    return { space, published: true, sections, updated: now };
  }

  /** Takes the person's card off a team (at once; nothing is kept). */
  async withdraw(caller: Caller, space: string) {
    const uid = this.person(caller);
    await this.spaces.enter(caller, space, 'cards.publish');
    await this.store.removeCard(space, uid);
    return { space, withdrawn: true };
  }

  /** The cards a caller may see in a team. A person sees their own card whole and, while it is published, each other
   *  card's sections that their own card also shows (symmetry, section by section) with the work indicators; the
   *  team's delegated agent sees what is published. Reading others' cards is noted in their view logs. */
  async list(caller: Caller, space: string) {
    const e = await this.spaces.enter(caller, space, 'cards.read');
    if (await this.store.cardsOff(space)) return { space, employee_mode: true, mine: null, cards: [], note: '이 팀은 직원 모드라 카드를 쓰지 않습니다' };
    const me = callerUid(caller), [cards, work] = await Promise.all([this.store.cards(space), this.store.shared(space)]);
    const own = me ? cards.find(c => c.uid === me) ?? null : null;
    const view = (c: Card, sees: Set<CardSection> | null) => {
      const secs = c.sections.filter(s => !sees || sees.has(s)), traits = secs.filter((s): s is Trait => (TRAITS as readonly string[]).includes(s));
      return { uid: c.uid, sections: secs, measured: c.measured, stale: !!c.measured && Date.now() - c.measured > STALE_DAYS * 864e5,
        traits: traitView(c.scores, traits), ...(secs.includes('direction') && c.direction ? { direction: c.direction } : {}),
        work: workIndicators(work.filter(w => w.uid === c.uid)),
        rebuttal: { ...(traits.length && c.rebuttal.traits ? { traits: c.rebuttal.traits } : {}), ...(c.rebuttal.work ? { work: c.rebuttal.work } : {}),
          ...(secs.includes('direction') && c.rebuttal.direction ? { direction: c.rebuttal.direction } : {}) },
        published: c.published, updated: c.updated };
    };
    if (caller.kind === 'person' && !own) {
      return { space, employee_mode: false, mine: null, cards: [], others_published: cards.length,
        note: '내 카드를 공개해야 다른 사람의 카드가 보입니다. 내가 공개한 항목만큼만 서로 보입니다.' };
    }
    const sees = caller.kind === 'person' ? new Set(own!.sections) : null;
    const others = cards.filter(c => c.uid !== me).sort((a, b) => a.published - b.published).map(c => view(c, sees)).filter(c => c.sections.length || c.work.rows);
    await this.views?.saw(caller, e.relation, space, new Map(others.map(c => [c.uid, 1])), 'card');
    return { space, employee_mode: false, mine: own ? view(own, null) : null, cards: others };
  }

  /** Employee mode (the owner's switch): on, every card in the team is removed and none can be published. */
  async setEmployeeMode(caller: Caller, space: string, on: boolean) {
    this.person(caller);
    await this.spaces.enter(caller, space, 'cards.mode');
    await this.store.setCardsOff(space, on);
    let removed = 0;
    if (on) for (const c of await this.store.cards(space)) { await this.store.removeCard(space, c.uid); removed++; }
    return { space, employee_mode: on, removed };
  }
}

/** Traits as shown: the label, the score in the shown direction (emotional stability for N), the raw sum and alpha. */
export function traitView(scores: Partial<Record<Trait, number>>, only?: Trait[]) {
  return (only ?? TRAITS.filter(t => scores[t] !== undefined)).filter(t => scores[t] !== undefined)
    .map(t => ({ trait: t, label: TRAIT_KO[t], score: shown(t, scores[t]!), raw: scores[t]!, of: 20, alpha: ALPHA[t] }));
}

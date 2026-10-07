// The NAV log's rules as a table of cases, run against SQLite (sqlite.test.ts) and the memory
// database (memory.test.ts) so both follow them (used by the *.test.ts files only).

import type { NavPoint } from '@shared/types';
import type { NavLog } from './types';

/** The user's accounts: paper (about 1,051,500) and live (31,030.71). */
export const PAPER = 'DU1234567';
export const LIVE = 'U7654321';

const pt = (t: number, netLiq: number): NavPoint => ({ t, netLiq });
const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour, minute);

/** The paper account's samples, on several days around the live session. */
export const PAPER_ROWS: readonly NavPoint[] = [
  pt(at(1, 20), 1_051_500),
  pt(at(2, 20), 1_051_600),
  pt(at(5, 20), 1_051_700),
  pt(at(6, 13, 50), 1_051_650),
  pt(at(6, 14, 30), 1_051_680),
];
/** The live account's three samples (about 7 minutes on 2026-10-06, between paper sessions). */
export const LIVE_ROWS: readonly NavPoint[] = [pt(at(6, 14, 1), 31_030.71), pt(at(6, 14, 4), 31_030.71), pt(at(6, 14, 7), 31_030.71)];
/** What the table held before schema v4: both accounts' samples, without an account, by time. */
export const USER_ROWS: readonly NavPoint[] = [...PAPER_ROWS, ...LIVE_ROWS].sort((a, b) => a.t - b.t);

/** Each account's points after a step; '' holds the unattributed rows. Accounts left out have none. */
export type NavState = Record<string, NavPoint[]>;

export type NavStep = ({ append: string | null; points: NavPoint[] } | { replace: string; points: NavPoint[] }) & {
  then?: NavState;
  /** lastAccount() after the step (undefined: none). */
  lastAccount?: string;
};

export interface NavCase {
  name: string;
  /** Rows without an account, there before the first step (written before schema v4). */
  legacy: readonly NavPoint[];
  steps: NavStep[];
}

const S1 = at(7, 14);
const S2 = at(7, 15);
const join = (...lists: ReadonlyArray<readonly NavPoint[]>) => lists.flat().sort((a, b) => a.t - b.t);

export const NAV_CASES: readonly NavCase[] = [
  {
    name: "the user's case, paper first: each account's first sample claims its own rows; the other's stay hidden until it samples",
    legacy: USER_ROWS,
    steps: [
      { append: PAPER, points: [pt(S1, 1_051_800)], then: { [PAPER]: join(PAPER_ROWS, [pt(S1, 1_051_800)]), '': [...LIVE_ROWS] }, lastAccount: PAPER },
      { append: LIVE, points: [pt(S2, 31_040)], then: { [PAPER]: join(PAPER_ROWS, [pt(S1, 1_051_800)]), [LIVE]: join(LIVE_ROWS, [pt(S2, 31_040)]) }, lastAccount: LIVE },
    ],
  },
  {
    name: 'the same split with the live account first',
    legacy: USER_ROWS,
    steps: [
      { append: LIVE, points: [pt(S1, 31_040)], then: { [LIVE]: join(LIVE_ROWS, [pt(S1, 31_040)]), '': [...PAPER_ROWS] } },
      { append: PAPER, points: [pt(S2, 1_051_800)], then: { [LIVE]: join(LIVE_ROWS, [pt(S1, 31_040)]), [PAPER]: join(PAPER_ROWS, [pt(S2, 1_051_800)]) } },
    ],
  },
  {
    name: 'an account claims once: unattributed rows written later (a nav.json import) stay unattributed; null never claims',
    legacy: USER_ROWS,
    steps: [
      { append: null, points: [pt(at(3, 20), 1_051_550)], then: { '': join(USER_ROWS, [pt(at(3, 20), 1_051_550)]) }, lastAccount: undefined },
      { append: PAPER, points: [pt(S1, 1_051_800)] },
      { append: null, points: [pt(at(4, 20), 1_051_000)] },
      {
        append: PAPER,
        points: [pt(S2, 1_051_900)],
        then: { [PAPER]: join(PAPER_ROWS, [pt(at(3, 20), 1_051_550), pt(S1, 1_051_800), pt(S2, 1_051_900)]), '': join(LIVE_ROWS, [pt(at(4, 20), 1_051_000)]) },
      },
    ],
  },
  {
    name: 'bounds: rows at exactly half and twice the first sample are claimed, rows just outside are not',
    legacy: [pt(1_000, 49_999.99), pt(2_000, 50_000), pt(3_000, 200_000), pt(4_000, 200_000.01)],
    steps: [{ append: 'DU1', points: [pt(5_000, 100_000)], then: { DU1: [pt(2_000, 50_000), pt(3_000, 200_000), pt(5_000, 100_000)], '': [pt(1_000, 49_999.99), pt(4_000, 200_000.01)] } }],
  },
  {
    name: "a time held by another owner is left alone (an import over a claimed row, another account's sample); the same account replaces its value",
    legacy: [pt(1_000, 100), pt(3_000, 1)],
    steps: [
      { append: 'DU1', points: [pt(2_000, 100)], then: { DU1: [pt(1_000, 100), pt(2_000, 100)], '': [pt(3_000, 1)] } },
      { append: null, points: [pt(1_000, 999)] },
      { append: 'U2', points: [pt(2_000, 5)] },
      { append: 'DU1', points: [pt(3_000, 102)], then: { DU1: [pt(1_000, 100), pt(2_000, 100)], '': [pt(3_000, 1)] }, lastAccount: 'DU1' },
      { append: 'DU1', points: [pt(2_000, 101)], then: { DU1: [pt(1_000, 100), pt(2_000, 101)], '': [pt(3_000, 1)] } },
    ],
  },
  {
    name: "replace (compaction) changes one account's rows only and claims nothing",
    legacy: [...USER_ROWS, pt(at(6, 15), 5)],
    steps: [
      { append: PAPER, points: [pt(S1, 1_051_800)] },
      { append: LIVE, points: [pt(S2, 31_040)] },
      {
        replace: PAPER,
        points: [PAPER_ROWS[2], pt(S1, 1_051_800)],
        then: { [PAPER]: [PAPER_ROWS[2], pt(S1, 1_051_800)], [LIVE]: join(LIVE_ROWS, [pt(S2, 31_040)]), '': [pt(at(6, 15), 5)] },
      },
      { replace: 'U9', points: [pt(at(8, 1), 5)], then: { [PAPER]: [PAPER_ROWS[2], pt(S1, 1_051_800)], [LIVE]: join(LIVE_ROWS, [pt(S2, 31_040)]), U9: [pt(at(8, 1), 5)], '': [pt(at(6, 15), 5)] } },
    ],
  },
  {
    name: 'lastAccount is the account of the newest attributed row; unattributed rows after it are skipped',
    legacy: [pt(1_000, 100)],
    steps: [
      { append: null, points: [pt(500, 100)], lastAccount: undefined },
      { append: 'DU1', points: [pt(2_000, 100)], lastAccount: 'DU1' },
      { append: 'U2', points: [pt(3_000, 5)], lastAccount: 'U2' },
      { append: null, points: [pt(4_000, 7)], lastAccount: 'U2' },
      { append: 'DU1', points: [pt(2_500, 100)], lastAccount: 'U2' },
    ],
  },
];

/** Every account a case writes to. */
export const caseAccounts = (c: NavCase): string[] => [...new Set(c.steps.map((s) => ('append' in s ? s.append : s.replace)).filter((a): a is string => !!a))];

export function applyNavStep(log: NavLog, step: NavStep): Promise<void> {
  return 'append' in step ? log.append(step.append, step.points) : log.replace(step.replace, step.points);
}

/** Each account's points and the unattributed rows (every row no account's read returns). */
export async function navState(log: NavLog, accounts: readonly string[]): Promise<NavState> {
  const state: NavState = {};
  const owned = new Set<number>();
  for (const a of accounts) {
    const points = await log.get(a);
    for (const p of points) owned.add(p.t);
    if (points.length) state[a] = points;
  }
  const rest = (await log.all()).filter((p) => !owned.has(p.t));
  if (rest.length) state[''] = rest;
  return state;
}

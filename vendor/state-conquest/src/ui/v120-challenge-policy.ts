/**
 * v1.2 challenge-code eligibility.
 *
 * The codec itself (encodeChallengeV2 / decodeChallengeAny) belongs to the
 * challenge/leaderboard module. This file owns the *policy* question only:
 * given what actually happened during a finished match, may its score be
 * published as a comparable challenge, as a practice code, or not at all?
 *
 * Rules (all must hold for a comparable "fair" code):
 *   1. single-player match (versus is never shareable);
 *   2. the active skill was locked for the whole match (betrayal level 0);
 *   3. the speed never changed mid-match and equals the code's fixed speed;
 *   4. the code carries the current rules version.
 *
 * A fresh archive starts at betrayal level 0, so the very first finished solo
 * match is already fair-eligible: practice-only games cannot block the first
 * comparable challenge code from ever being created.
 *
 * Anything else still gets an explicit practice code (never a silent refusal),
 * except versus, which has no code at all.
 */

import type { MatchMode } from './view-model';
import { isMatchSpeed } from './v120-speed';
import type { MatchSpeed } from './v120-speed';

/** Keep in sync with the challenge codec's exported version. */
export const V120_RULES_VERSION = 2;

export type ChallengeFairness = 'fair' | 'practice';

export type CodeEligibilityReason =
  | 'versus'
  | 'unfinished'
  | 'speed-changed'
  | 'betrayal-active'
  | 'diplomacy-used'
  | 'rules-mismatch'
  | 'invalid-speed';

export interface MatchRuleFacts {
  mode: MatchMode;
  /** Match-level betrayal level read from the core HUD (0 = locked). */
  betrayalLevel: number;
  /** True once any in-match speed change happened. */
  speedChanged: boolean;
  /** Speed the match started with; a fair code locks exactly this value. */
  initialSpeed: MatchSpeed;
  /** Challenge target score when the match was played from a code. */
  challengeScore?: number | null;
  finished?: boolean;
  diplomacyUsed?: boolean;
  /**
   * Total seated factions of the match (2 = 1v1, 3/4 = 1 player + AIs).
   * Omitted on older call sites means the historical two-faction match;
   * anything other than 2/3/4 is read as 2 rather than minting a mislabeled
   * multi-party code.
   */
  factionCount?: number;
}

export interface CodeEligibility {
  /** A code may be generated at all. Versus never gets one. */
  codeAllowed: boolean;
  /** 'fair' is comparable, 'practice' is explicitly non-comparable. */
  fairness: ChallengeFairness;
  /** Can this score be compared against other codes of the current version? */
  comparable: boolean;
  /** Fixed speed stamped into the code (never the live value after a switch). */
  speed: MatchSpeed | null;
  reason: CodeEligibilityReason | null;
  /** Short player-facing explanation; empty for a plain fair result. */
  notice: string;
  /** Total factions the code's match ran with; always filled (2 when unstated). */
  factionCount: number;
}

export interface EligibilityOptions {
  /** Codec version to stamp; defaults to V120_RULES_VERSION. */
  rulesVersion?: number;
  /** Override the expected version when a codec is injected by tests. */
  currentRulesVersion?: number;
}

/**
 * Decides the code family for one finished match. Pure: it never mutates the
 * facts and never inspects live game state, so the shell can call it exactly
 * once at settlement and tests can pin every branch.
 */
export function evaluateCodeEligibility(
  facts: MatchRuleFacts,
  options?: EligibilityOptions
): CodeEligibility {
  const current =
    options && typeof options.currentRulesVersion === 'number'
      ? options.currentRulesVersion
      : V120_RULES_VERSION;
  const rulesVersion =
    options && typeof options.rulesVersion === 'number'
      ? options.rulesVersion
      : V120_RULES_VERSION;
  const finished = facts.finished !== false;
  const speedOk = isMatchSpeed(facts.initialSpeed);
  const betrayalLevel =
    typeof facts.betrayalLevel === 'number' && isFinite(facts.betrayalLevel)
      ? facts.betrayalLevel
      : 0;
  // Faction count is a pure pass-through dimension: a 3/4-party match follows
  // exactly the same fairness, speed, betrayal and version rules as a 1v1.
  const factionCount =
    facts.factionCount === 3 || facts.factionCount === 4 ? facts.factionCount : 2;

  if (facts.mode === 'versus') {
    return {
      codeAllowed: false,
      fairness: 'practice',
      comparable: false,
      speed: speedOk ? facts.initialSpeed : null,
      reason: 'versus',
      notice: '双人对局不生成挑战码',
      factionCount: factionCount,
    };
  }
  if (!finished) {
    return {
      codeAllowed: false,
      fairness: 'practice',
      comparable: false,
      speed: speedOk ? facts.initialSpeed : null,
      reason: 'unfinished',
      notice: '对局未结束，无法生成挑战码',
      factionCount: factionCount,
    };
  }
  if (!speedOk) {
    return {
      codeAllowed: false,
      fairness: 'practice',
      comparable: false,
      speed: null,
      reason: 'invalid-speed',
      notice: '本局速度异常，无法生成挑战码',
      factionCount: factionCount,
    };
  }

  const practiceBase: CodeEligibility = {
    codeAllowed: true,
    fairness: 'practice',
    comparable: false,
    // A practice code always records the speed the match STARTED with, so the
    // score can never be read as a different pace than it was first played at.
    speed: facts.initialSpeed,
    reason: null,
    notice: '',
    factionCount: factionCount,
  };

  if (facts.diplomacyUsed) {
    return {
      ...practiceBase,
      reason: 'diplomacy-used',
      notice: '本局使用过外交 · 仅练习码，不参与排名',
    };
  }
  if (facts.speedChanged) {
    return {
      ...practiceBase,
      reason: 'speed-changed',
      notice: '本局中途切换过速度 · 仅练习码，不参与排名',
    };
  }
  if (betrayalLevel > 0) {
    return {
      ...practiceBase,
      reason: 'betrayal-active',
      notice: '本局启用策反 · 仅练习码，不参与排名',
    };
  }
  if (rulesVersion !== current) {
    return {
      ...practiceBase,
      reason: 'rules-mismatch',
      notice: '规则版本不一致 · 仅练习码，不参与排名',
    };
  }
  return {
    codeAllowed: true,
    fairness: 'fair',
    comparable: true,
    speed: facts.initialSpeed,
    reason: null,
    notice: '',
    factionCount: factionCount,
  };
}

/**
 * Acceptance policy for an incoming code. Legacy `SC` codes stay playable as
 * historical same-map practice but are never ranked; a v2/v3 code is
 * comparable only when it was fair, fixed-speed and minted by this rules
 * version. A v3 (multi-party) code must state its own legal faction count —
 * the policy never guesses one.
 */
export interface DecodedCodeFacts {
  family: 'legacy' | 'v2' | 'v3';
  /** Codec-declared fairness (v2/v3 only). */
  fairness?: ChallengeFairness;
  /** Speed stamped in the code (v2/v3 only). */
  speed?: unknown;
  /** null/undefined on legacy codes, which never recorded a version. */
  rulesVersion?: number | null;
  comparable?: boolean;
  /**
   * Total factions stated by a v3 code (3|4). Required for v3: a missing or
   * illegal value is a hard refusal, never silently read as 2.
   */
  factionCount?: number;
}

export interface CodeAcceptance {
  playable: boolean;
  comparable: boolean;
  /** HUD copy shown on the challenge screen and the result screen. */
  notice: string;
  /** Settlement must not write a ranked leaderboard row. */
  practiceOnly: boolean;
  /**
   * Total factions this challenge runs with: 2 for the legacy/v2 families,
   * the decoded 3|4 for a valid v3 code. 0 only on the v3 refusal path where
   * no legal count was stated — it must never be read as "two factions".
   */
  factionCount: number;
}

/**
 * Reads the faction count a decoded code actually states: 2 for the
 * pre-v1.4 families, the decoded 3|4 for a v3 code, and null for a v3 code
 * that arrived without a legal count (a hard refusal downstream, never a
 * silent "two factions").
 */
function statedFactionCount(facts: DecodedCodeFacts): number | null {
  if (facts.family === 'legacy' || facts.family === 'v2') return 2;
  return facts.factionCount === 3 || facts.factionCount === 4
    ? facts.factionCount
    : null;
}

export function evaluateCodeAcceptance(
  facts: DecodedCodeFacts,
  options?: EligibilityOptions
): CodeAcceptance {
  const current =
    options && typeof options.currentRulesVersion === 'number'
      ? options.currentRulesVersion
      : V120_RULES_VERSION;
  if (facts.family === 'legacy') {
    return {
      playable: true,
      comparable: false,
      notice:
        '旧版 SC 挑战码 · 仅作为历史同图练习，不比较比分、不进入本机榜。',
      practiceOnly: true,
      factionCount: 2,
    };
  }
  // A multi-party code owns its count: without a legal 3|4 the code is not
  // openable at all. Defaulting it to 2 would quietly turn a 3/4-party match
  // into a 1v1 and mix its scores into two-faction groups.
  const stated = statedFactionCount(facts);
  if (stated === null) {
    return {
      playable: false,
      comparable: false,
      notice: '多方挑战码未声明合法人数（3 或 4 方），无法打开。',
      practiceOnly: true,
      factionCount: 0,
    };
  }
  const factionCount = stated;
  const speedOk = isMatchSpeed(facts.speed);
  const fair = facts.fairness === 'fair';
  const fresh = facts.rulesVersion === current;
  const comparable = fair && speedOk && fresh && facts.comparable !== false;
  if (comparable) {
    return {
      playable: true,
      comparable: true,
      notice: '',
      practiceOnly: false,
      factionCount: factionCount,
    };
  }
  const reasons: string[] = [];
  if (!fair) reasons.push('练习码');
  if (!speedOk) reasons.push('速度无效');
  if (!fresh) reasons.push('规则版本不一致');
  if (facts.comparable === false && reasons.length === 0) reasons.push('不可比');
  return {
    playable: true,
    comparable: false,
    notice:
      '该挑战码不可比较（' +
      reasons.join('、') +
      '）· 可作练习对局，比分不进入排名。',
    practiceOnly: true,
    factionCount: factionCount,
  };
}

/** Short HUD label used next to the speed chip. */
export function fairnessLabel(eligibility: CodeEligibility): string {
  if (!eligibility.codeAllowed) return '无挑战码';
  return eligibility.fairness === 'fair' ? '公平挑战' : '练习';
}

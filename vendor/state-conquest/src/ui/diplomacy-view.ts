/**
 * Pure presentation model for the v2.0.0 diplomacy sheet.
 *
 * Everything here is derived from the adapter MatchView snapshot only — no
 * core imports at runtime — so the sheet can be unit-tested without a DOM and
 * the shell keeps one thin render path. Reason codes come from the frozen
 * game-api contract (`TruceProposalReason`): `ok: false` codes are legality
 * refusals the AI never judged, `accept-*`/`reject-*` codes are genuine AI
 * interest decisions. The UI must never blur that line.
 *
 * Shared-passage note reflects verified mechanics: core reachability judges
 * targets with isHostileAt, so while a truce is active the dispatch range
 * (sourceReachableTargets preview) already spans routes across the partner's
 * frontier, while ownership, colours and armies stay independent.
 */
import {
  activeFactions,
  factionDisplayName,
  isFactionAlive,
} from './factions';
import type { FactionOwner } from './factions';
import type { TruceProposalReason } from '../game-api';
import type {
  MatchView,
  PendingTruceOfferView,
  TruceView,
} from './view-model';

/** Engine ticks per wall-clock second; the sheet shows seconds only. */
const TICKS_PER_SECOND = 10;

export type DiplomacyRowState =
  | 'active'
  | 'cooldown'
  | 'available'
  | 'pending'
  | 'disabled';

export interface DiplomacyRowView {
  owner: FactionOwner;
  name: string;
  state: DiplomacyRowState;
  /** Row copy: relation phase, remaining seconds, or the block reason. */
  detail: string;
  /** '提议停战' | '解除停战'. */
  actionLabel: string;
  /** Accessible name for the row action. */
  actionAria: string;
  /** True when the boolean offer/break can fire for this snapshot. */
  actionable: boolean;
  /** Plain-language reason shown when not actionable; '' when actionable. */
  disabledReason: string;
}

export interface PendingOfferView {
  offer: PendingTruceOfferView;
  proposer: FactionOwner;
  proposerName: string;
  secondsLeft: number;
  motivation: string;
  factorsText: string;
}

export interface DiplomacyPanelView {
  enabled: boolean;
  uses: number;
  pendingOffer: PendingOfferView | null;
  /** Alive AI factions still seated (diplomacy targets, roster order). */
  targets: FactionOwner[];
  /** The player's active truce partner (de-facto ally), if any. */
  ally: FactionOwner | null;
  /** Display name of the ally; '' when there is no ally. */
  allyName: string;
  /** Seconds left on the ally truce; 0 when there is no ally. */
  allySecondsLeft: number;
  /** How the ally came to be, when the snapshot carries the verdict. */
  allyDecisionText: string;
  /** Alive factions hostile to both the player and the ally. */
  commonEnemies: FactionOwner[];
  /** Display names for commonEnemies, same order. */
  commonEnemyNames: string[];
  /** Alive seats including the player; below 3 the core refuses proposals. */
  aliveSeats: number;
  /** True while the match is playing or paused (the sheet pauses). */
  matchRunning: boolean;
  rows: DiplomacyRowView[];
  /** Verified shared-passage mechanics copy; '' when diplomacy is closed. */
  passageNote: string;
}

/* --------------------------------------------------------------- */
/* Frozen reason-code copy (game-api TruceProposalReason)           */
/* --------------------------------------------------------------- */

/** `ok: false` legality refusals: the AI never judged these. */
const LEGALITY_REASON_TEXT: Record<TruceProposalReason, string> = {
  'disabled': '本模式不开放外交。',
  'not-playing': '对局已结束，外交不再可用。',
  'invalid': '提议无效，请关闭本页后重新查看。',
  'self': '不能与己方提议停战。',
  'unknown-target': '目标势力不存在。',
  'target-dead': '目标势力已淘汰。',
  'too-few-alive': '存活方不足3方，无法提议停战。',
  'already-allied': '双方已经是盟友。',
  'ally-limit': '每方最多同时拥有1个盟友。',
  'cooldown': '上次提议仍在冷却中。',
  'offer-not-found': '合作邀请已失效，未记为拒绝。',
  'offer-expired': '合作邀请已过期，未记为拒绝。',
  'offer-invalidated': '合作邀请已失效，未记为拒绝。',
  // Decision codes never appear as legality refusals; the entries below only
  // satisfy the exhaustive record type.
  'accept-common-threat': '',
  'accept-opportunity': '',
  'accept-front-relief': '',
  'accept-underdog': '',
  'reject-dominant': '',
  'reject-winning': '',
  'reject-no-benefit': '',
};

/** Real AI accept verdicts (`ok: true`, accepted). */
const ACCEPT_REASON_TEXT: Partial<Record<TruceProposalReason, string>> = {
  'accept-common-threat': '面对共同威胁，对方接受结盟。',
  'accept-opportunity': '对方认为时机有利，接受结盟。',
  'accept-front-relief': '减轻前线压力，对方接受结盟。',
  'accept-underdog': '对方处于劣势，接受结盟自保。',
};

/** Real AI reject verdicts (`ok: true`, not accepted). */
const REJECT_REASON_TEXT: Partial<Record<TruceProposalReason, string>> = {
  'reject-dominant': '你的优势过大，对方不愿助你扩张，拒绝结盟。',
  'reject-winning': '对方局势领先，无意停战。',
  'reject-no-benefit': '对方看不到停战的好处，拒绝结盟。',
};

/** Explain the frozen decision's concrete benefits without exposing raw AI scores. */
export function truceAssessmentText(record: TruceView): string {
  const factors = record.lastDecisionFactors;
  if (!factors) return '';
  const notes: string[] = [];
  if (factors.commonThreats > 0) notes.push('有 ' + factors.commonThreats + ' 方可同时威胁双方');
  if (factors.incomingThreat > 0) notes.push('对方正面对 ' + Math.round(factors.incomingThreat) + ' 在途敌兵');
  if (factors.sharedTargets > 0) notes.push('对方借道后新增 ' + factors.sharedTargets + ' 处可进攻目标');
  if (factors.borderRelief > 0) notes.push('停战可减轻双方交界压力');
  if (notes.length === 0 && record.lastDecision === 'rejected') notes.push('没有足够的共同威胁或可达借道收益');
  return notes.join('；') + (notes.length > 0 ? '。' : '');
}

/** Human copy for a legality refusal; unknown codes stay honest and plain. */
export function truceLegalityText(reason: TruceProposalReason): string {
  return LEGALITY_REASON_TEXT[reason] || '提议未生效，请关闭本页后重新查看。';
}

/**
 * Human copy for an AI verdict (accept-* / reject-*). Returns '' for codes
 * outside the decision set so legality and AI outcomes never mix.
 */
export function truceDecisionText(reason: string): string {
  return (
    ACCEPT_REASON_TEXT[reason as TruceProposalReason] ||
    REJECT_REASON_TEXT[reason as TruceProposalReason] ||
    ''
  );
}

/** Failure copy for responding to an offer; never describes it as AI rejection. */
export function truceOfferFailureText(reason: string): string {
  if (reason === 'offer-expired') return '合作邀请已过期，未记为拒绝。';
  if (reason === 'offer-invalidated') return '合作邀请已失效，未记为拒绝。';
  if (reason === 'offer-not-found') return '合作邀请已失效，未记为拒绝。';
  return '合作邀请未生效，未记为拒绝。';
}

const OFFER_REASON_TEXT: Partial<Record<TruceProposalReason, string>> = {
  'accept-common-threat': '希望与我方共同应对外部威胁',
  'accept-opportunity': '认为合作能带来更好的进攻机会',
  'accept-front-relief': '希望减轻自身前线压力',
  'accept-underdog': '处于劣势，希望先稳住自身战线',
};

/** AI-facing motivation copy; scores and internal weights never reach the UI. */
export function truceOfferMotivation(offer: PendingTruceOfferView): string {
  const name = factionDisplayName(offer.from as FactionOwner);
  const reason =
    OFFER_REASON_TEXT[offer.reason] || '希望通过暂时合作改善自身战局';
  return name + reason + '。';
}

/** Concrete, readable factors from the offer's receiver-side assessment. */
export function truceOfferFactorsText(offer: PendingTruceOfferView): string {
  const factors = offer.factors;
  const notes: string[] = [];
  if (factors.commonThreats > 0) {
    notes.push('共同威胁 ' + factors.commonThreats + ' 方');
  }
  if (factors.incomingThreat > 0) {
    notes.push(Math.round(factors.incomingThreat) + ' 名敌兵正在逼近');
  }
  if (factors.sharedTargets > 0) {
    notes.push('可新增 ' + factors.sharedTargets + ' 处进攻目标');
  }
  if (factors.borderRelief > 0 || factors.threatRelief > 0) {
    notes.push('可减轻交界压力');
  }
  if (factors.underdog > 0) notes.push('自身处于劣势');
  return notes.length > 0 ? notes.join(' · ') : '当前战线压力与机会评估';
}

/** The one incoming offer the player can act on in a snapshot, if any. */
export function pendingOfferForPlayer(view: MatchView): PendingOfferView | null {
  const diplomacy = view.diplomacy;
  if (!diplomacy || !diplomacy.enabled) return null;
  const truces = diplomacy.truces;
  for (let i = 0; i < truces.length; i += 1) {
    const offer = truces[i].pendingOffer;
    if (!offer || offer.to !== 'player' || offer.from === 'player') continue;
    if (offer.expiresTick <= view.tick) continue;
    const proposer = offer.from as FactionOwner;
    return {
      offer: offer,
      proposer: proposer,
      proposerName: factionDisplayName(proposer),
      secondsLeft: secondsLeft(view.tick, offer.expiresTick),
      motivation: truceOfferMotivation(offer),
      factorsText: truceOfferFactorsText(offer),
    };
  }
  return null;
}

/* --------------------------------------------------------------- */
/* Snapshot derivation                                              */
/* --------------------------------------------------------------- */

function relationFor(
  truces: readonly TruceView[],
  a: FactionOwner,
  b: FactionOwner
): TruceView | null {
  for (let i = 0; i < truces.length; i += 1) {
    const record = truces[i];
    if (
      (record.a === a && record.b === b) ||
      (record.a === b && record.b === a)
    ) {
      return record;
    }
  }
  return null;
}

function activeBetween(
  truces: readonly TruceView[],
  tick: number,
  a: FactionOwner,
  b: FactionOwner
): boolean {
  const record = relationFor(truces, a, b);
  return (
    record !== null &&
    !record.pendingOffer &&
    record.expiresTick > tick
  );
}

function secondsLeft(fromTick: number, untilTick: number): number {
  return Math.max(0, Math.ceil((untilTick - fromTick) / TICKS_PER_SECOND));
}

function recordDecisionText(record: TruceView): string {
  if (
    record.lastDecisionKind === 'ai-offer' &&
    (record.lastDecisionOutcome === 'accepted' ||
      record.lastDecision === 'accepted')
  ) {
    const proposer = record.lastDecisionProposer;
    const proposerName =
      proposer && proposer !== 'player'
        ? factionDisplayName(proposer as FactionOwner)
        : '对方';
    return '你接受了' + proposerName + '的合作邀请。';
  }
  if (record.lastDecisionReason === 'accept-common-threat' &&
      record.lastDecisionFactors && record.lastDecisionFactors.commonThreats === 0) {
    return '对方需要缓解第三方压力，接受结盟。';
  }
  return truceDecisionText(record.lastDecisionReason || '');
}

/** Copy for a cooldown row, honest about direction and expiry. */
function cooldownCopy(record: TruceView, tick: number): string {
  const seconds = secondsLeft(tick, record.cooldownUntilTick);
  const outcome = record.lastDecisionOutcome;
  let verdict: string;
  if (outcome === 'expired') {
    verdict = record.lastDecisionKind === 'ai-offer'
      ? '合作邀请已过期。'
      : '提议已过期。';
  } else if (outcome === 'invalidated') {
    verdict = record.lastDecisionKind === 'ai-offer'
      ? '合作邀请已失效。'
      : '提议已失效。';
  } else if (outcome === 'rejected' && record.lastDecisionKind === 'ai-offer') {
    verdict = '你拒绝了这次合作邀请。';
  } else if (outcome === 'rejected' || record.lastDecision === 'rejected') {
    // Legacy records have no direction metadata, so retain their established
    // player-proposal wording for backwards compatibility.
    verdict =
      truceDecisionText(record.lastDecisionReason || '') ||
      '对方拒绝了这次提议。';
  } else {
    verdict = '上一段停战已结束。';
  }
  const assessment =
    record.lastDecisionKind === 'ai-offer' ? '' : truceAssessmentText(record);
  return verdict + assessment + '冷却 ' + seconds + ' 秒后可再次提议。';
}

/** The player's raw relation record with one faction, if any exists. */
export function playerHasActiveAlly(view: MatchView): boolean {
  const truces = view.diplomacy ? view.diplomacy.truces : [];
  const tick = view.tick;
  for (let i = 0; i < truces.length; i += 1) {
    const record = truces[i];
    if (
      (record.a === 'player' || record.b === 'player') &&
      !record.pendingOffer &&
      record.expiresTick > tick
    ) {
      return true;
    }
  }
  return false;
}

export function playerPairRecord(
  view: MatchView,
  owner: FactionOwner
): TruceView | null {
  const truces = view.diplomacy ? view.diplomacy.truces : [];
  return relationFor(truces, 'player', owner);
}

export function deriveDiplomacyPanel(view: MatchView): DiplomacyPanelView {
  const diplomacy = view.diplomacy;
  const enabled = !!diplomacy && diplomacy.enabled === true;
  const truces = diplomacy ? diplomacy.truces : [];
  const uses =
    diplomacy && typeof diplomacy.uses === 'number' && diplomacy.uses >= 0
      ? diplomacy.uses
      : 0;
  const pendingOffer = pendingOfferForPlayer(view);
  const tick = view.tick;
  const matchRunning = view.status === 'playing' || view.status === 'paused';
  const targets: FactionOwner[] = [];
  const factions = activeFactions(view);
  let aliveSeats = 0;
  for (let i = 0; i < factions.length; i += 1) {
    const owner = factions[i];
    // A defeated faction is no longer a diplomacy target; in-flight armies
    // keep a faction alive through the core's aliveOwners snapshot.
    if (!isFactionAlive(view, owner)) continue;
    if (owner !== 'player') targets.push(owner);
    aliveSeats += 1;
  }

  let ally: FactionOwner | null = null;
  for (let i = 0; i < targets.length; i += 1) {
    if (activeBetween(truces, tick, 'player', targets[i])) {
      ally = targets[i];
      break;
    }
  }
  const allyRecord =
    ally !== null ? (relationFor(truces, 'player', ally) as TruceView) : null;
  const allySecondsLeft = allyRecord
    ? secondsLeft(tick, allyRecord.expiresTick)
    : 0;
  const allyDecisionText =
    allyRecord &&
    (allyRecord.lastDecisionOutcome === 'accepted' ||
      allyRecord.lastDecision === 'accepted')
      ? recordDecisionText(allyRecord) + truceAssessmentText(allyRecord)
      : '';

  // Shared enemies: alive factions in neither the player's nor the ally's
  // active truce set. With no ally this list is just the player's enemies.
  const commonEnemies: FactionOwner[] = [];
  for (let i = 0; i < targets.length; i += 1) {
    const owner = targets[i];
    if (owner === ally) continue;
    if (activeBetween(truces, tick, 'player', owner)) continue;
    if (ally !== null && activeBetween(truces, tick, ally, owner)) continue;
    commonEnemies.push(owner);
  }

  const rows: DiplomacyRowView[] = targets.map(function (owner) {
    const record = relationFor(truces, 'player', owner);
    const pendingForOwner =
      pendingOffer !== null && pendingOffer.proposer === owner;
    const active =
      record !== null && !record.pendingOffer && record.expiresTick > tick;
    const cooling =
      record !== null &&
      record.expiresTick <= tick &&
      record.cooldownUntilTick > tick;
    const state: DiplomacyRowState = active
      ? 'active'
      : cooling
        ? 'cooldown'
        : 'available';
    if (pendingForOwner && pendingOffer) {
      const detail =
        pendingOffer.proposerName +
        '已发来合作邀请 · 剩余 ' +
        pendingOffer.secondsLeft +
        ' 秒';
      return {
        owner: owner,
        name: factionDisplayName(owner),
        state: 'pending',
        detail: detail,
        actionLabel: '查看合作邀请',
        actionAria: '查看合作邀请',
        actionable: false,
        disabledReason: '已有待处理的合作邀请。',
      };
    }
    if (active && record) {
      // Breaks stay available even in a 2-seat endgame: only proposals are
      // subject to the alive-seat and ally-limit rules.
      const actionable = enabled && matchRunning;
      return {
        owner: owner,
        name: factionDisplayName(owner),
        state: 'active',
        detail: '停战中 · 剩余 ' + secondsLeft(tick, record.expiresTick) + ' 秒',
        actionLabel: '解除停战',
        actionAria: factionDisplayName(owner) + '，解除停战',
        actionable: actionable,
        disabledReason: actionable
          ? ''
          : enabled
            ? '对局已结束，外交不再可用。'
            : '本模式不开放外交。',
      };
    }
    if (cooling && record) {
      const copy = cooldownCopy(record, tick);
      return {
        owner: owner,
        name: factionDisplayName(owner),
        state: 'cooldown',
        detail: copy,
        actionLabel: '提议停战',
        actionAria: factionDisplayName(owner) + '，提议停战',
        actionable: false,
        disabledReason: copy,
      };
    }
    // Offer path: mirror the core legality chain in display order so the
    // sheet never enables an action the engine would refuse.
    let blocked = '';
    if (!enabled) blocked = LEGALITY_REASON_TEXT['disabled'];
    else if (!matchRunning) blocked = LEGALITY_REASON_TEXT['not-playing'];
    else if (aliveSeats < 3) blocked = LEGALITY_REASON_TEXT['too-few-alive'];
    else if (ally !== null && ally !== owner)
      blocked =
        '每方最多1个盟友（当前盟友：' + factionDisplayName(ally) + '）。';
    return {
      owner: owner,
      name: factionDisplayName(owner),
      state: blocked ? 'disabled' : 'available',
      detail: blocked || '交战中 · 可提议 60 秒停战',
      actionLabel: '提议停战',
      actionAria: factionDisplayName(owner) + '，提议停战',
      actionable: !blocked,
      disabledReason: blocked,
    };
  });

  return {
    enabled: enabled,
    uses: uses,
    pendingOffer: pendingOffer,
    targets: targets,
    ally: ally,
    allyName: ally ? factionDisplayName(ally) : '',
    allySecondsLeft: allySecondsLeft,
    allyDecisionText: allyDecisionText,
    commonEnemies: commonEnemies,
    commonEnemyNames: commonEnemies.map(factionDisplayName),
    aliveSeats: aliveSeats,
    matchRunning: matchRunning,
    rows: rows,
    passageNote: enabled
      ? '停战期间可沿相连的己方/盟友领地借道（以出兵预览高亮为准），' +
        '兵源到前线须有真实可通行路径，盟约不会自动接通断开的地图。' +
        '操作：按住己方兵源，直接拖到盟友前沿后的目标，不要先拖到盟友地。' +
        '地图标记「借道前沿」，绿色虚线标记可落点。盟友驻军仍归盟友，不能直接指挥盟友部队，控地分各算各的。'
      : '',
  };
}

import { SHIELD_PER_DEFENSE_LEVEL } from '../config/balance';
import type { FactionCount, MatchState, OwnerId, TruceRecord } from './types';

const OWNERS: OwnerId[] = ['player', 'ai1', 'ai2', 'ai3', 'neutral'];
const FACTION_COUNTS: FactionCount[] = [2, 3, 4];

function seatedOwner(state: MatchState, owner: string): boolean {
  return owner !== 'neutral' && state.activeOwners.indexOf(owner as MatchState['activeOwners'][number]) >= 0;
}

const TRUCE_PAIR_ORDER: OwnerId[] = ['player', 'ai1', 'ai2', 'ai3'];

/**
 * Canonical unordered pair key: (ai1,player) and (player,ai1) are the same
 * relation. Legacy fixtures may store either order — neither is enforced, the
 * canonical form is only used for duplicate detection.
 */
function trucePairKey(a: OwnerId, b: OwnerId): string {
  const ia = TRUCE_PAIR_ORDER.indexOf(a);
  const ib = TRUCE_PAIR_ORDER.indexOf(b);
  return ia <= ib ? a + '\u0000' + b : b + '\u0000' + a;
}

/** Returns a list of invariant violations. Empty means healthy. */
export function checkInvariants(state: MatchState): string[] {
  const errors: string[] = [];
  const statuses = ['ready', 'playing', 'paused', 'ended'];
  if (statuses.indexOf(state.status) < 0) errors.push('invalid status: ' + state.status);
  if (
    state.lastProgressTick !== undefined &&
    (!isFinite(state.lastProgressTick) ||
      Math.floor(state.lastProgressTick) !== state.lastProgressTick ||
      state.lastProgressTick < 0 ||
      state.lastProgressTick > state.tick)
  ) {
    errors.push('invalid lastProgressTick');
  }
  if (state.stalemateWarned !== undefined && typeof state.stalemateWarned !== 'boolean') {
    errors.push('invalid stalemateWarned');
  }
  if (state.diplomacy) {
    if (typeof state.diplomacy.enabled !== 'boolean') errors.push('invalid diplomacy enabled');
    if (!isFinite(state.diplomacy.uses) || Math.floor(state.diplomacy.uses) !== state.diplomacy.uses || state.diplomacy.uses < 0) {
      errors.push('invalid diplomacy uses');
    }
    if (
      state.diplomacy.aiOfferCooldownUntilTick !== undefined &&
      (!isFinite(state.diplomacy.aiOfferCooldownUntilTick) ||
        Math.floor(state.diplomacy.aiOfferCooldownUntilTick) !== state.diplomacy.aiOfferCooldownUntilTick ||
        state.diplomacy.aiOfferCooldownUntilTick < 0)
    ) {
      errors.push('invalid AI offer cooldown');
    }
    const seenTruces: Record<string, boolean> = {};
    let pendingOffers = 0;
    const activeDegree: Record<string, number> = {};
    for (let i = 0; i < state.diplomacy.truces.length; i += 1) {
      const truce: TruceRecord = state.diplomacy.truces[i];
      const key = trucePairKey(truce.a, truce.b);
      if (seenTruces[key]) errors.push('duplicate truce ' + key);
      seenTruces[key] = true;
      if (truce.a === truce.b || !seatedOwner(state, truce.a) || !seatedOwner(state, truce.b)) {
        errors.push('invalid truce owners ' + key);
      }
      if (
        !isFinite(truce.startedTick) ||
        !isFinite(truce.expiresTick) ||
        !isFinite(truce.cooldownUntilTick) ||
        truce.startedTick < 0 ||
        truce.expiresTick < truce.startedTick ||
        truce.cooldownUntilTick < truce.expiresTick
      ) {
        errors.push('invalid truce ticks ' + key);
      }
      // Optional proposal bookkeeping; validated only when present so
      // legacy fixtures keep passing unchanged.
      if (
        truce.lastDecision !== undefined &&
        truce.lastDecision !== 'accepted' &&
        truce.lastDecision !== 'rejected'
      ) {
        errors.push('invalid truce lastDecision ' + key);
      }
      if (
        truce.lastDecisionTick !== undefined &&
        (!isFinite(truce.lastDecisionTick) || truce.lastDecisionTick < 0)
      ) {
        errors.push('invalid truce lastDecisionTick ' + key);
      }
      if (truce.lastDecisionFactors) {
        const factors = truce.lastDecisionFactors;
        const keys = Object.keys(factors) as Array<keyof typeof factors>;
        for (let k = 0; k < keys.length; k += 1) {
          if (!isFinite(factors[keys[k]]) || factors[keys[k]] < 0) {
            errors.push('invalid truce decision factor ' + key + ':' + keys[k]);
          }
        }
      }
      if (
        truce.lastDecisionKind !== undefined &&
        truce.lastDecisionKind !== 'player-proposal' &&
        truce.lastDecisionKind !== 'ai-offer'
      ) {
        errors.push('invalid truce decision kind ' + key);
      }
      if (
        truce.lastDecisionOutcome !== undefined &&
        truce.lastDecisionOutcome !== 'accepted' &&
        truce.lastDecisionOutcome !== 'rejected' &&
        truce.lastDecisionOutcome !== 'expired' &&
        truce.lastDecisionOutcome !== 'invalidated'
      ) {
        errors.push('invalid truce decision outcome ' + key);
      }
      if (
        truce.lastDecisionProposer !== undefined &&
        !seatedOwner(state, truce.lastDecisionProposer)
      ) {
        errors.push('invalid truce decision proposer ' + key);
      }
      if (
        truce.lastDecisionResponder !== undefined &&
        !seatedOwner(state, truce.lastDecisionResponder)
      ) {
        errors.push('invalid truce decision responder ' + key);
      }
      if (truce.pendingOffer) {
        pendingOffers += 1;
        const offer = truce.pendingOffer;
        if (typeof offer.id !== 'string' || offer.id.length === 0) {
          errors.push('invalid pending offer id ' + key);
        }
        if (
          offer.from === 'player' ||
          offer.to !== 'player' ||
          !seatedOwner(state, offer.from) ||
          !seatedOwner(state, offer.to) ||
          trucePairKey(truce.a, truce.b) !== trucePairKey(offer.from, offer.to)
        ) {
          errors.push('invalid pending offer owners ' + key);
        }
        if (
          !isFinite(offer.createdTick) ||
          !isFinite(offer.expiresTick) ||
          Math.floor(offer.createdTick) !== offer.createdTick ||
          Math.floor(offer.expiresTick) !== offer.expiresTick ||
          offer.createdTick < 0 ||
          offer.expiresTick <= offer.createdTick
        ) {
          errors.push('invalid pending offer ticks ' + key);
        }
        if (truce.expiresTick > state.tick) {
          errors.push('pending offer is active ' + key);
        }
        const offerKeys = Object.keys(offer.factors) as Array<keyof typeof offer.factors>;
        for (let k = 0; k < offerKeys.length; k += 1) {
          if (!isFinite(offer.factors[offerKeys[k]]) || offer.factors[offerKeys[k]] < 0) {
            errors.push('invalid pending offer factor ' + key + ':' + offerKeys[k]);
          }
        }
      }
      // One ally per faction is a hard simulation rule (proposeTruce enforces
      // it on both sides), so any active record pair sharing a faction is a
      // corrupt state. Inactive records (cooldown/rejection) are exempt.
      if (truce.expiresTick > state.tick) {
        activeDegree[truce.a] = (activeDegree[truce.a] || 0) + 1;
        activeDegree[truce.b] = (activeDegree[truce.b] || 0) + 1;
      }
    }
    if (pendingOffers > 1) errors.push('multiple pending AI offers');
    const degreeOwners = Object.keys(activeDegree);
    for (let i = 0; i < degreeOwners.length; i += 1) {
      if (activeDegree[degreeOwners[i]] > 1) {
        errors.push('faction holds multiple active truces: ' + degreeOwners[i]);
      }
    }
  }

  // Seating contract: fixed factionCount plus a duplicate-free activeOwners
  // roster that matches it. activeOwners is the match-long seat list (distinct
  // from alive), so eliminated owners legitimately stay seated.
  if (FACTION_COUNTS.indexOf(state.factionCount) < 0) {
    errors.push('invalid factionCount: ' + state.factionCount);
  }
  const seated: Record<string, boolean> = {};
  for (let i = 0; i < state.activeOwners.length; i += 1) {
    const owner = state.activeOwners[i];
    if ((owner as string) === 'neutral' || seated[owner]) {
      errors.push('invalid activeOwner ' + owner);
    }
    seated[owner] = true;
  }
  if (!seated['player']) errors.push('player is not seated');
  if (seated['ai2'] && state.factionCount < 3) errors.push('ai2 seated below factionCount 3');
  if (seated['ai3'] && state.factionCount < 4) errors.push('ai3 seated below factionCount 4');


  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const id = state.territoryOrder[i];
    const territory = state.territories[id];
    if (!territory) {
      errors.push('missing territory ' + id);
      continue;
    }
    if (territory.id !== id) errors.push('territory id mismatch ' + id);
    if (OWNERS.indexOf(territory.owner) < 0) errors.push('invalid owner on ' + id);
    if (
      territory.owner !== 'neutral' &&
      !seated[territory.owner]
    ) {
      errors.push('unseated owner on ' + id + ': ' + territory.owner);
    }
    if (!isFinite(territory.troops) || Math.floor(territory.troops) !== territory.troops) {
      errors.push('non-integer troops on ' + id + ': ' + territory.troops);
    }
    if (territory.troops < 0 || territory.troops > territory.capacity) {
      errors.push('troops out of range on ' + id + ': ' + territory.troops + '/' + territory.capacity);
    }
    if (territory.owner !== 'neutral' && territory.troops < 1) {
      errors.push('owned territory has no garrison: ' + id);
    }
    if (territory.capacity <= 0) errors.push('invalid capacity on ' + id);
    if (!isFinite(territory.productionRemainder)) {
      errors.push('non-finite production remainder on ' + id);
    } else if (territory.productionRemainder < 0 || territory.productionRemainder >= 1) {
      errors.push('production remainder out of range on ' + id + ': ' + territory.productionRemainder);
    }
    if ([1, 2, 3].indexOf(territory.productionLevel) < 0) {
      errors.push('invalid production level on ' + id);
    }
    if ([1, 2, 3].indexOf(territory.marchLevel) < 0) {
      errors.push('invalid march level on ' + id);
    }
    if ([0, 1, 2].indexOf(territory.defenseLevel) < 0) {
      errors.push('invalid defense level on ' + id);
    } else if (territory.shieldCapacity !== SHIELD_PER_DEFENSE_LEVEL * territory.defenseLevel) {
      errors.push('shield capacity mismatch on ' + id);
    }
    if (
      !isFinite(territory.shield) ||
      Math.floor(territory.shield) !== territory.shield ||
      territory.shield < 0 ||
      territory.shield > territory.shieldCapacity
    ) {
      errors.push('shield out of range on ' + id + ': ' + territory.shield);
    }
    if (!isFinite(territory.cannonRange) || territory.cannonRange < 0) {
      errors.push('invalid cannon range on ' + id);
    }
    if (!isFinite(territory.cannonReadyTick) || territory.cannonReadyTick < 0) {
      errors.push('invalid cannon ready tick on ' + id);
    }
    if (territory.owner === 'neutral') {
      const remainder = territory.neutralRecoveryRemainder;
      if (remainder !== undefined && (!isFinite(remainder) || remainder < 0 || remainder >= 1)) {
        errors.push('neutral recovery remainder out of range on ' + id);
      }
      if (
        territory.lastDamagedTick !== undefined &&
        (!isFinite(territory.lastDamagedTick) || Math.floor(territory.lastDamagedTick) !== territory.lastDamagedTick)
      ) {
        errors.push('invalid neutral last damaged tick on ' + id);
      }
    } else if (territory.neutralRecoveryTarget !== undefined && territory.neutralRecoveryTarget > 0) {
      errors.push('owned territory keeps neutral recovery on ' + id);
    }
  }

  const seenArmyIds: Record<number, boolean> = {};
  for (let i = 0; i < state.armies.length; i += 1) {
    const army = state.armies[i];
    if (seenArmyIds[army.id]) errors.push('duplicate army id ' + army.id);
    seenArmyIds[army.id] = true;
    if ((army.owner as string) === 'neutral') errors.push('neutral army ' + army.id);
    if (!seated[army.owner]) errors.push('unseated army owner ' + army.id);
    if (!isFinite(army.troops) || army.troops < 1 || Math.floor(army.troops) !== army.troops) {
      errors.push('invalid army troops ' + army.id);
    }
    if (!state.territories[army.sourceId]) errors.push('army source missing ' + army.id);
    if (!state.territories[army.targetId]) errors.push('army target missing ' + army.id);
    if (army.arrivalTick <= army.startTick) errors.push('army arrival is not in the future ' + army.id);
    if (army.routePoints !== undefined) {
      if (!Array.isArray(army.routePoints) || army.routePoints.length < 2) {
        errors.push('invalid army route ' + army.id);
      } else {
        for (let p = 0; p < army.routePoints.length; p += 1) {
          const point = army.routePoints[p];
          if (
            !Array.isArray(point) ||
            !isFinite(point[0]) ||
            !isFinite(point[1]) ||
            point[0] < -1e-6 ||
            point[1] < -1e-6 ||
            point[0] > state.mapWidth + 1e-6 ||
            point[1] > state.mapHeight + 1e-6
          ) {
            errors.push('army route point out of bounds ' + army.id);
            break;
          }
        }
      }
    }
  }

  for (let i = 0; i < state.edges.length; i += 1) {
    const edge = state.edges[i];
    if (!state.territories[edge.from] || !state.territories[edge.to]) {
      errors.push('edge endpoint missing ' + edge.id);
    }
    if (edge.from === edge.to) errors.push('self edge ' + edge.id);
    if (!isFinite(edge.travelFactor) || edge.travelFactor <= 0) {
      errors.push('invalid travel factor ' + edge.id);
    }
  }

  // Continuous supply lines: at most one per (owner, source), integer counters,
  // live endpoints only. They never own troops, so no force accounting here.
  const fronts = state.fronts || [];
  const seenFrontIds: Record<number, boolean> = {};
  const seenFrontSlots: Record<string, boolean> = {};
  for (let i = 0; i < fronts.length; i += 1) {
    const front = fronts[i];
    if (seenFrontIds[front.id]) errors.push('duplicate front id ' + front.id);
    seenFrontIds[front.id] = true;
    if ((front.owner as string) === 'neutral') errors.push('neutral front ' + front.id);
    if (!seated[front.owner]) errors.push('unseated front owner ' + front.id);
    const slot = front.owner + '\u0000' + front.sourceId;
    if (seenFrontSlots[slot]) errors.push('duplicate front for source ' + front.sourceId);
    seenFrontSlots[slot] = true;
    if (!state.territories[front.sourceId]) errors.push('front source missing ' + front.id);
    if (!state.territories[front.targetId]) errors.push('front target missing ' + front.id);
    if (front.sourceId === front.targetId) errors.push('front targets itself ' + front.id);
    if (!isFinite(front.ratio) || front.ratio < 0 || front.ratio > 1) {
      errors.push('invalid front ratio ' + front.id);
    }
    if (!isFinite(front.totalSent) || front.totalSent < 0) {
      errors.push('invalid front totalSent ' + front.id);
    }
    const counters = [
      front.waves,
      front.totalSent,
      front.nextSendTick,
    ];
    for (let c = 0; c < counters.length; c += 1) {
      if (!isFinite(counters[c]) || Math.floor(counters[c]) !== counters[c]) {
        errors.push('non-integer front counter ' + front.id);
        break;
      }
    }
    const engagement = front.engagement;
    if (engagement) {
      if (engagement.targetId !== front.targetId) {
        errors.push('front engagement target mismatch ' + front.id);
      }
      const values = [
        engagement.waves,
        engagement.troopsArrived,
        engagement.damageDealt,
        engagement.shieldDamage,
        engagement.troopDamage,
        engagement.lastDefence,
        engagement.failedWaves,
      ];
      for (let v = 0; v < values.length; v += 1) {
        if (!isFinite(values[v]) || Math.floor(values[v]) !== values[v] || values[v] < 0) {
          errors.push('invalid front engagement counter ' + front.id);
          break;
        }
      }
    }
  }
  if (state.nextFrontId !== undefined) {
    if (!isFinite(state.nextFrontId) || state.nextFrontId < 1) {
      errors.push('invalid nextFrontId');
    } else {
      for (let i = 0; i < fronts.length; i += 1) {
        if (fronts[i].id >= (state.nextFrontId as number)) {
          errors.push('front id beyond nextFrontId ' + fronts[i].id);
        }
      }
    }
  }

  return errors;
}

export function assertInvariants(state: MatchState): void {
  const errors = checkInvariants(state);
  if (errors.length) throw new Error('Invariant violation: ' + errors.join('; '));
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return ('00000000' + hash.toString(16)).slice(-8);
}

/** Deterministic state fingerprint used by replay tests. */
export function hashState(state: MatchState): string {
  const parts: string[] = [];
  parts.push(state.status, String(state.tick), String(state.result), String(state.nextArmyId));
  if (
    state.endReason !== undefined ||
    state.lastProgressTick !== undefined ||
    state.stalemateWarned !== undefined ||
    state.diplomacy
  ) {
    parts.push(
      'v2:' +
        String(state.endReason || '') +
        ':' +
        String(state.lastProgressTick === undefined ? -1 : state.lastProgressTick) +
        ':' +
        (state.stalemateWarned ? '1' : '0')
    );
    if (state.diplomacy) {
      parts.push('d:' + String(state.diplomacy.enabled ? 1 : 0) + ':' + String(state.diplomacy.uses));
      if (state.diplomacy.aiOfferCooldownUntilTick !== undefined) {
        parts.push('g:' + String(state.diplomacy.aiOfferCooldownUntilTick));
      }
      const truces = state.diplomacy.truces.slice().sort(function (a, b) {
        const ak = a.a + '\\u0000' + a.b;
        const bk = b.a + '\\u0000' + b.b;
        return ak < bk ? -1 : ak > bk ? 1 : 0;
      });
      for (let i = 0; i < truces.length; i += 1) {
        const truce = truces[i];
        // Proposal metadata is appended ONLY when present: a record without the
        // 2.0.0 decision fields hashes byte-identical to the legacy form, and
        // the reason (when it exists) is part of the fingerprint so two states
        // differing only in the last verdict text can never collide.
        let decisionSuffix = '';
        if (truce.lastDecision !== undefined) {
          decisionSuffix =
            ':' +
            truce.lastDecision.charAt(0) +
            ':' +
            (truce.lastDecisionTick === undefined ? -1 : truce.lastDecisionTick) +
            (truce.lastDecisionReason !== undefined
              ? ':' + truce.lastDecisionReason
              : '');
        }
        if (truce.lastDecisionFactors) {
          const factors = truce.lastDecisionFactors;
          const keys = Object.keys(factors).sort() as Array<keyof typeof factors>;
          decisionSuffix += ':f:' + keys.map(function (key) { return key + '=' + factors[key]; }).join(',');
        }
        if (truce.lastDecisionKind !== undefined) {
          decisionSuffix += ':k:' + truce.lastDecisionKind;
        }
        if (truce.lastDecisionProposer !== undefined) {
          decisionSuffix += ':p:' + truce.lastDecisionProposer;
        }
        if (truce.lastDecisionResponder !== undefined) {
          decisionSuffix += ':r:' + truce.lastDecisionResponder;
        }
        if (truce.lastDecisionOutcome !== undefined) {
          decisionSuffix += ':o:' + truce.lastDecisionOutcome;
        }
        if (truce.pendingOffer) {
          const pending = truce.pendingOffer;
          const pendingKeys = Object.keys(pending.factors).sort() as Array<keyof typeof pending.factors>;
          decisionSuffix +=
            ':po:' + pending.id + ':' + pending.from + ':' + pending.to + ':' +
            pending.createdTick + ':' + pending.expiresTick + ':' + pending.reason +
            ':pf:' + pendingKeys.map(function (key) { return key + '=' + pending.factors[key]; }).join(',');
        }
        parts.push(
          't:' + truce.a + ':' + truce.b + ':' + truce.startedTick + ':' +
          truce.expiresTick + ':' + truce.cooldownUntilTick + decisionSuffix
        );
      }
    }
  }
  for (let i = 0; i < state.territoryOrder.length; i += 1) {
    const territory = state.territories[state.territoryOrder[i]];
    parts.push(
      territory.id +
        ':' +
        territory.owner +
        ':' +
        String(territory.troops) +
        ':' +
        String(territory.productionLevel) +
        ':' +
        territory.productionRemainder.toFixed(6) +
        ':' +
        String(territory.marchLevel) +
        ':' +
        String(territory.defenseLevel) +
        ':' +
        String(territory.shield) +
        ':' +
        String(territory.cannonReadyTick) +
        ':' +
        (territory.neutralRecoveryRemainder || 0).toFixed(6) +
        ':' +
        String(territory.lastDamagedTick === undefined ? -1 : territory.lastDamagedTick)
    );
  }
  const armies = state.armies.slice().sort(function (a, b) {
    return a.id - b.id;
  });
  for (let i = 0; i < armies.length; i += 1) {
    const army = armies[i];
    parts.push(
      'a' +
        army.id +
        ':' +
        army.owner +
        ':' +
        army.sourceId +
        '>' +
        army.targetId +
        ':' +
        String(army.troops) +
        ':' +
        String(army.arrivalTick) +
        // Only continuous-line waves carry this, so single-shot armies keep the
        // exact pre-v1.2 hash.
        (army.frontId === undefined ? '' : ':f' + String(army.frontId))
    );
  }
  parts.push(
    's:' +
      state.stats.ordersByPlayer +
      ':' +
      state.stats.capturesByPlayer +
      ':' +
      state.stats.troopsSentByPlayer +
      ':' +
      state.stats.maxTerritoriesByPlayer +
      ':' +
      state.stats.upgradesByPlayer
  );
  // Continuous lines are part of the deterministic future (they dispatch on
  // their own cadence and their ids must keep incrementing), so a replay
  // comparison covers both the identities and the live cadence. Nothing is
  // appended when no line exists, so every pre-v1.2 state keeps its old hash.
  if (typeof state.nextFrontId === 'number' && state.nextFrontId !== 1) {
    parts.push('nf:' + String(state.nextFrontId));
  }
  const fronts = (state.fronts || []).slice().sort(function (a, b) {
    return a.id - b.id;
  });
  for (let i = 0; i < fronts.length; i += 1) {
    const front = fronts[i];
    parts.push(
      'f' +
        front.id +
        ':' +
        front.owner +
        ':' +
        front.sourceId +
        '>' +
        front.targetId +
        ':' +
        front.ratio.toFixed(4) +
        ':' +
        String(front.startTick) +
        ':' +
        String(front.nextSendTick) +
        ':' +
        String(front.waves) +
        ':' +
        String(front.totalSent) +
        ':' +
        (front.engagement
          ? [
              front.engagement.targetId,
              front.engagement.targetOwner,
              front.engagement.waves,
              front.engagement.troopsArrived,
              front.engagement.damageDealt,
              front.engagement.shieldDamage,
              front.engagement.troopDamage,
              front.engagement.lastDefence,
              front.engagement.failedWaves,
            ].join('/')
          : '-')
    );
  }
  return fnv1a(parts.join('|'));
}

import { SEAT_TO_OWNER, SEATS } from '@state/arena';
import type { ArenaRecord, ArenaRound, ArenaResult, MatchSnapshot, PlayerId, SeatId } from '@state/arena';
import type { MediaSource, MediaEvent } from '@state/media';
import type { DecisionSummary, Outcome, ReplayMap, ReplaySnapshot, RunEvent, RunSummary } from './types.js';
import { isObject } from './security.js';

export const SPECTATOR_ACCESS = { privateMessages: true, note: '本地观众全知；私信只在双方模型观察中可见' } as const;
export function recordedRounds(record: ArenaRecord): ArenaRound[] {
  const rounds = new Map<number, ArenaRound>();
  for (const entry of record.entries) {
    if (entry.type === 'BEGIN' || entry.type === 'COMMIT') rounds.set(entry.round.index, { ...entry.round, responses: { ...entry.round.responses }, attempts: { ...entry.round.attempts } });
    else if (entry.type === 'DECISION') {
      const round = rounds.get(entry.roundIndex);
      if (round) {
        round.responses[entry.value.seat] = entry.value;
        const attempts = round.attempts[entry.value.seat];
        if (attempts?.length) attempts[attempts.length - 1] = { ...attempts.at(-1)!, status: 'answered', costUsd: entry.value.response.costUsd };
      }
    } else if (entry.type === 'INVOKE') {
      const round = rounds.get(entry.roundIndex);
      if (round) round.attempts[entry.seat] = [...(round.attempts[entry.seat] ?? []), { id: entry.attemptId, status: 'pending' }];
    } else if (entry.type === 'FAILURE' || entry.type === 'SETTLE') {
      const round = rounds.get(entry.roundIndex);
      if (round) round.attempts[entry.seat] = (round.attempts[entry.seat] ?? []).map(attempt => attempt.id !== entry.attemptId ? attempt : entry.type === 'FAILURE'
        ? { ...attempt, status: 'failed', error: entry.message } : { ...attempt, status: 'settled', costUsd: entry.costUsd });
    } else if (entry.type === 'COST') {
      const round = rounds.get(entry.roundIndex), stored = round?.responses[entry.seat];
      if (round && stored) round.responses[entry.seat] = { ...stored, response: { ...stored.response, costUsd: entry.costUsd,
        metadata: { ...stored.response.metadata, costActualReconciled: true, costEstimateIncomplete: false } } };
    }
  }
  return [...rounds.values()].sort((a, b) => a.index - b.index);
}
export function decisionSummary(round: ArenaRound, seat: SeatId, models: readonly string[]): DecisionSummary {
  const response = round.responses[seat]?.response;
  const receipt = round.receipts[seat];
  let intent: string | undefined;
  if (response) {
    try { const parsed: unknown = JSON.parse(response.text); if (isObject(parsed) && typeof parsed.intent === 'string') intent = parsed.intent; } catch { /* The protocol receipt supplies the real parsing error. */ }
  }
  const actions = receipt ? [...receipt.actions, ...receipt.diplomacy] : [];
  const invalid = receipt && (!receipt.valid || actions.some(action => !action.accepted));
  const metadata = response?.metadata;
  const latency = metadata?.latencyMs;
  const incomplete = metadata?.costActualReconciled !== true && (metadata?.costEstimateIncomplete === true || metadata?.usageIsPartial === true);
  const failure = round.attempts[seat]?.findLast(attempt => attempt.status === 'failed');
  return {
    round: round.index, tick: round.startTick, owner: SEAT_TO_OWNER[seat], modelId: models[SEATS.indexOf(seat)] ?? '',
    status: invalid || (!response && failure) ? 'error' : round.committed && receipt ? 'applied' : response ? 'received' : 'waiting',
    ...(intent !== undefined ? { intent } : {}), ...(receipt ? { receipts: actions } : {}),
    ...(typeof latency === 'number' ? { latencyMs: latency } : {}),
    ...(response ? { costUsd: !incomplete && response.costUsd !== undefined ? response.costUsd : null } : {}),
    ...(invalid ? { error: receipt.parseError ?? actions.filter(action => !action.accepted).map(action => action.reason ?? 'Action rejected.').join('; ') } : !response && failure ? { error: failure.error ?? 'Model invocation failed.' } : {}),
  };
}
const REPLAY_ACTION_TYPES = new Set(['move', 'upgrade', 'set_front', 'stop_front', 'wait', 'public', 'private', 'offer', 'accept', 'reject', 'break']);
export function replayDecisionSummary(round: ArenaRound, seat: SeatId, models: readonly string[]): DecisionSummary {
  const summary = decisionSummary(round, seat, models);
  if (summary.intent !== undefined) summary.intent = summary.intent.slice(0, 2000);
  const receipt = round.receipts[seat];
  if (receipt) summary.receipts = [...receipt.actions, ...receipt.diplomacy].map(({ seat, actionIndex, action, accepted, reason }) => {
    const type = isObject(action) && typeof action.type === 'string' && REPLAY_ACTION_TYPES.has(action.type) ? action.type : undefined;
    return { seat, actionIndex, accepted, ...(reason === undefined ? {} : { reason }), ...(type === undefined ? {} : { action: { type } }) };
  });
  return summary;
}
export function replayMap(snapshot: MatchSnapshot): ReplayMap {
  const { edges, layout, geog } = snapshot;
  const territories = Object.fromEntries(snapshot.territories.map(({ id, polygon, center, labelAnchor, labelLeader }) => [id, { polygon, center, labelAnchor, labelLeader }]));
  return structuredClone({ edges, layout, geog, territories });
}
export function replaySnapshot(snapshot: MatchSnapshot): ReplaySnapshot {
  const { edges, layout, geog, territories, ...fields } = snapshot;
  return { ...fields, territories: territories.map(({ polygon, center, labelAnchor, labelLeader, ...territory }) => territory) };
}
export function outcome(result: ArenaResult | null): Outcome | null {
  return result ? { reason: result.reason, standings: result.ranking.map(rank => ({ owner: SEAT_TO_OWNER[rank.seat], rank: rank.rank, score: rank.score, territories: rank.lands, troops: rank.force })) } : null;
}
const EVENT_TITLES: Record<string, string> = { capture: '领地易主', upgrade: '领地升级', eliminated: '阵营淘汰', cannon: '炮台命中', defend: '防守损失', front: '兵线变化', overflow: '驻军溢出' };
export function eventsFromRecord(record: ArenaRecord, rounds: readonly ArenaRound[] = recordedRounds(record)): RunEvent[] {
  const events: RunEvent[] = [];
  for (const round of rounds.filter(item => item.committed)) {
    for (const [batchIndex, batch] of round.events.entries()) {
      for (const [index, event] of batch.events.entries()) events.push({
        id: `r${round.index}-t${batch.tick}-b${batchIndex}-e${index}`, tick: event.tick, type: event.type,
        title: EVENT_TITLES[event.type] ?? event.type,
        detail: `${event.targetId} · ${event.amount}`, ...(event.owner ? { owner: event.owner } : {}),
        visibility: 'public', payload: event,
      });
    }
    for (const seat of round.seats) for (const [index, receipt] of (round.receipts[seat]?.diplomacy ?? []).entries()) {
      if (!receipt.accepted || !isObject(receipt.action)) continue;
      const type = receipt.action.type;
      if (type !== 'accept' && type !== 'break' && type !== 'offer' && type !== 'reject') continue;
      const target = receipt.action.to;
      const to = typeof target === 'string' && SEATS.includes(target as SeatId) ? SEAT_TO_OWNER[target as SeatId] : undefined;
      events.push({ id: `r${round.index}-${seat}-d${index}`, tick: round.startTick, type: type === 'accept' ? 'alliance' : type,
        title: type === 'accept' ? '正式盟约成立' : type === 'break' ? '主动解除盟约' : type === 'offer' ? '盟约提议' : '拒绝盟约',
        owner: SEAT_TO_OWNER[seat], from: SEAT_TO_OWNER[seat], ...(to ? { to } : {}), visibility: 'public', payload: receipt });
    }
  }
  const messages = new Map<string, RunEvent>();
  for (const entry of record.entries) if (entry.type === 'COMMIT') for (const message of entry.checkpoint.aux.messages) {
    messages.set(message.id, { id: `message-${message.id}`, tick: message.tick, type: message.to === 'public' ? 'public_message' : 'private_message',
      title: message.to === 'public' ? '公开消息' : '阵营私信', detail: message.text, owner: SEAT_TO_OWNER[message.from], from: SEAT_TO_OWNER[message.from],
      ...(message.to !== 'public' ? { to: SEAT_TO_OWNER[message.to] } : {}), visibility: message.to === 'public' ? 'public' : 'private', payload: message });
  }
  return [...events, ...messages.values()].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
}
export function mediaSource(run: RunSummary, record: ArenaRecord, result: ArenaResult | null, labels: ReadonlyMap<string, string>, facts?: { rounds: readonly ArenaRound[]; events: readonly RunEvent[] }): MediaSource {
  const events: MediaEvent[] = [];
  const owners = Object.values(SEAT_TO_OWNER) as PlayerId[];
  for (const event of facts?.events ?? eventsFromRecord(record)) {
    if (!event.owner) continue;
    const payload = isObject(event.payload) ? event.payload : {};
    if (event.type === 'capture' && typeof payload.targetId === 'string') events.push({ id: event.id, tick: event.tick, type: 'capture', factionId: event.owner,
      territoryId: payload.targetId, ...(payload.previousOwner === 'neutral' ? { fromFactionId: null } : typeof payload.previousOwner === 'string' && owners.includes(payload.previousOwner as PlayerId) ? { fromFactionId: payload.previousOwner } : {}) });
    else if (event.type === 'eliminated') events.push({ id: event.id, tick: event.tick, type: 'elimination', factionId: event.owner });
    else if ((event.type === 'cannon' || event.type === 'defend') && typeof payload.amount === 'number' && payload.amount > 0) events.push({ id: event.id, tick: event.tick, type: 'battle', factionId: event.owner, damage: payload.amount });
    else if ((event.type === 'alliance' || event.type === 'break') && event.to) events.push({ id: event.id, tick: event.tick, type: event.type, factionId: event.owner, otherFactionId: event.to });
  }
  const rounds = facts?.rounds ?? recordedRounds(record);
  return { runId: run.id, durationTicks: run.tick, ticksPerSecond: 10,
    factions: SEATS.slice(0, run.factionCount).map((seat, i) => ({ id: SEAT_TO_OWNER[seat], label: seat, modelId: run.models[i], modelLabel: labels.get(run.models[i]!) ?? run.models[i]! })),
    events, decisions: rounds.flatMap(round => round.seats.flatMap(seat => {
      const stored = round.responses[seat];
      if (!stored) return [];
      const decision = decisionSummary(round, seat, run.models);
      return [{ id: stored.decisionId, tick: round.startTick, factionId: SEAT_TO_OWNER[seat], ...(decision.intent !== undefined ? { intent: decision.intent } : {}) }];
    })),
    ...(result ? { outcome: { tick: result.tick, reason: result.reason, standings: result.ranking.map(rank => ({ factionId: SEAT_TO_OWNER[rank.seat], rank: rank.rank, score: rank.score, territories: rank.lands, troops: rank.force })) } } : {}),
    fingerprints: { engine: run.reproducibility.engineHash, protocol: run.reproducibility.protocolHash, prompt: run.reproducibility.promptHash, config: run.reproducibility.configHash, initial: record.manifest.initialFingerprint },
  };
}

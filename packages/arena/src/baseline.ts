import { planAiCommands } from '../../../.generated/state-conquest/src/ai/planner.js';
import { createRng } from '../../../.generated/state-conquest/src/core/rng.js';
import { noDisaster } from '../../../.generated/state-conquest/src/core/disaster.js';
import type { ActorRequest, ArenaActor, MatchState, ArenaAction } from './types.js';
import { SEAT_TO_OWNER } from './types.js';
import { clone } from './canonical.js';
import { createAliases } from './observation.js';
const contexts = new WeakMap<ActorRequest, MatchState>();
/** Internal binding; never a field on provider-visible requests. */
export function bindBaselineContext(request: ActorRequest, frozenState: MatchState): void { contexts.set(request, frozenState); }
export function createBaselineActor(strategy: 'normal' | 'hard' = 'normal'): ArenaActor {
  if (!['normal','hard'].includes(strategy)) throw new Error(`Unsupported original planner strategy: ${strategy}`);
  return async request => {
    const frozen = contexts.get(request);
    if (!frozen) throw new Error('Baseline actors must run through ArenaSession.step');
    const state = clone(frozen);
    // Forecasts cannot inspect a hidden seed-derived future event. All planning uses public geometry/stocks.
    state.seed = 0; state.mapId = 'arena-public'; state.mapName = 'arena-public'; state.disaster = noDisaster();
    state.difficulty = strategy;
    if (state.diplomacy) state.diplomacy.truces = state.diplomacy.truces.map(t=>({ a:t.a,b:t.b,startedTick:t.startedTick,expiresTick:t.expiresTick,cooldownUntilTick:t.cooldownUntilTick }));
    const rng = createRng(Number.parseInt(request.obsHash.slice(0,8),16));
    const planned = planAiCommands(state, SEAT_TO_OWNER[request.seat], rng, { force: true, maxCommands: 3 });
    const { toAlias } = createAliases(state);
    const actions: ArenaAction[] = planned.commands.map(c => c.type === 'upgrade' ? { type:'upgrade', territory:toAlias[c.sourceId],kind:c.kind ?? 'production' } : { type:'move',source:toAlias[c.sourceId],target:toAlias[c.targetId],ratio:c.ratio });
    return { text: JSON.stringify({ decision_id:request.decisionId,intent:`Original ${strategy} planner`, actions, memory_note:'', diplomacy:[] }), costUsd:0, usage:{ inputTokens:0,outputTokens:0 }, metadata:{ local:true,planner:strategy,attempts:0 } };
  };
}
export const baselineActor = createBaselineActor();

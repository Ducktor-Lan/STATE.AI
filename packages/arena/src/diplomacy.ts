import { proposeTruce, breakTruce, hasActiveAlly } from '../../../.generated/state-conquest/src/core/diplomacy.js';
import { cancelFrontsForEndedTruce } from '../../../.generated/state-conquest/src/core/fronts.js';
import { isFactionAlive } from '../../../.generated/state-conquest/src/core/score.js';
import type { MatchState, ArenaAuxState, ArenaConfig, SeatId, ActionReceipt, DiplomacyAction } from './types.js';
import { SEAT_TO_OWNER, SEATS } from './types.js';
import { clone } from './canonical.js';
const verdict = (accept: boolean) => ({ accept, reason: accept ? 'accept-opportunity' as const : 'reject-no-benefit' as const, score: accept ? 1 : -1 });
export function maintainArenaDiplomacy(state: MatchState, aux: ArenaAuxState): void {
  const alive = state.activeOwners.filter(o => isFactionAlive(state, o));
  aux.offers = aux.offers.filter(o => o.expiresTick > state.tick && alive.length >= 3 && alive.includes(SEAT_TO_OWNER[o.from]) && alive.includes(SEAT_TO_OWNER[o.to]) && !hasActiveAlly(state, SEAT_TO_OWNER[o.from]) && !hasActiveAlly(state, SEAT_TO_OWNER[o.to]));
}
export function applyDiplomacy(state: MatchState, aux: ArenaAuxState, config: ArenaConfig, seat: SeatId, value: unknown, index: number, roundIndex: number): ActionReceipt {
  const base = { seat, actionIndex: index, action: clone(value) };
  const fail = (reason: string) => ({ ...base, accepted: false, reason });
  if (config.track !== 'diplomacy') return fail('diplomacy disabled on strategy track');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid diplomacy operation');
  const d = value as DiplomacyAction;
  const keys: Record<string, string[]> = { public:['type','text'], private:['type','to','text'], offer:['type','to'], accept:['type','offer_id'], reject:['type','offer_id'], break:['type','to'] };
  if (typeof d.type !== 'string' || !Object.hasOwn(keys,d.type) || Object.keys(value).some(k => !keys[d.type].includes(k))) return fail('unexpected diplomacy fields');
  if (!isFactionAlive(state, SEAT_TO_OWNER[seat])) return fail('faction eliminated');
  const target = 'to' in d ? d.to : undefined;
  if (target && (!SEATS.slice(0,config.factionCount).includes(target) || target === seat)) return fail('invalid recipient');
  if (['private','offer','break'].includes(d.type) && !target) return fail('recipient required');
  if (d.type === 'public' || d.type === 'private') {
    if (typeof d.text !== 'string' || !d.text.trim() || d.text.length > 800) return fail('message must contain 1..800 characters');
    aux.messages.push({ id: `M${aux.nextMessageId++}`, from: seat, to: d.type === 'public' ? 'public' : d.to, text: d.text, tick: state.tick, availableRound: roundIndex + 1 });
    // Fixed retention bounds memory and prompt length; delivery never happens in the sending window.
    aux.messages = aux.messages.slice(-256);
    return { ...base, accepted: true };
  }
  maintainArenaDiplomacy(state, aux);
  if (d.type === 'offer') {
    if (aux.offers.some(o => (o.from === seat && o.to === d.to) || (o.to === seat && o.from === d.to))) return fail('pending offer already exists for pair');
    if (aux.offers.length >= 12) return fail('pending offer limit');
    // Invoke the real validator on an isolated copy; only the future recipient may consent.
    const legal = proposeTruce(clone(state), SEAT_TO_OWNER[seat], SEAT_TO_OWNER[d.to], () => verdict(true));
    if (!legal.ok || !legal.accepted) return fail(legal.reason);
    const offer = { id: `O${String(aux.nextOfferId++).padStart(6,'0')}`, from: seat, to: d.to, createdTick: state.tick, expiresTick: state.tick + 150, availableRound: roundIndex + 1 };
    aux.offers.push(offer);
    return { ...base, accepted: true, result: clone(offer) };
  }
  if (d.type === 'accept' || d.type === 'reject') {
    const offer = aux.offers.find(o => o.id === d.offer_id && o.to === seat && o.availableRound <= roundIndex);
    if (!offer) return fail('offer not found or not delivered to this recipient');
    const result = proposeTruce(state, SEAT_TO_OWNER[offer.from], SEAT_TO_OWNER[offer.to], () => verdict(d.type === 'accept'));
    aux.offers = aux.offers.filter(o => o.id !== offer.id);
    maintainArenaDiplomacy(state, aux);
    return { ...base, accepted: result.ok, reason: result.ok ? undefined : result.reason, result };
  }
  if (d.type === 'break') {
    const ok = breakTruce(state, SEAT_TO_OWNER[seat], SEAT_TO_OWNER[d.to]);
    if (ok) cancelFrontsForEndedTruce(state, SEAT_TO_OWNER[seat], SEAT_TO_OWNER[d.to]);
    return { ...base, accepted: ok, reason: ok ? undefined : 'no active alliance' };
  }
  return fail('unknown diplomacy operation');
}

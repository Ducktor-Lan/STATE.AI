import type { BroadcastRenderApi, RenderFrameInput } from '@state/media/types';
import { api } from './api';
import type { ModelSummary, StateFrame } from './api';
import { get } from './dom';
import { LivePlayback } from './live-playback';
import { errorMessage, formatClock, modelLabel, SEAT_LABELS, SEATS } from './model';
import { Battlefield } from './renderer';

declare global { interface Window { __STATE_AI_RENDER__?: BroadcastRenderApi } }

export async function startBroadcast(root: HTMLElement): Promise<void> {
  const query = new URLSearchParams(location.search);
  const pathId = location.pathname.startsWith('/broadcast/') ? decodeURIComponent(location.pathname.slice('/broadcast/'.length)) : '';
  const requestedRunId = pathId || query.get('run') || '';
  const offline = query.get('render') === '1';
  document.body.classList.add('broadcast-body');
  root.innerHTML = `<main class="broadcast-frame" data-testid="broadcast-frame" data-full-bleed>
    <header class="broadcast-header"><div class="broadcast-brand"><span class="brand-stamp" aria-hidden="true">寸土<br>必争</span><span class="brand-word">STATE.AI<small>模型对战实验室</small></span></div><div id="broadcast-title" class="broadcast-title">真实战局</div><div class="broadcast-clock"><span>游戏时间</span><strong id="broadcast-clock">00:00</strong></div></header>
    <div class="broadcast-content"><div class="broadcast-map"><canvas data-testid="broadcast-canvas" aria-label="真实对局的原作引擎地图"></canvas><div id="broadcast-error" class="broadcast-error" role="alert" hidden></div></div><aside class="broadcast-seats" id="broadcast-seats" aria-label="模型与比分"></aside></div>
    <footer class="broadcast-subtitles"><span class="subtitle-rule"></span><p id="broadcast-caption"></p></footer>
  </main>`;
  const canvas = get<HTMLCanvasElement>(root, '[data-testid="broadcast-canvas"]');
  const battlefield = new Battlefield(canvas, !offline);
  let models: ModelSummary[] = [];
  let actualRunId = '';
  const assertFrameRun = (frame: StateFrame): void => {
    if (!actualRunId || frame.run.id !== actualRunId) throw new Error('战局帧与已绑定的真实对局不一致。');
  };
  let maximum = 0;
  let lastTick = -1;
  let lastSegment = '';
  const cache = new Map<number, StateFrame>();
  const readFrame = async (tick: number): Promise<StateFrame> => {
    const cached = cache.get(tick);
    if (cached) return cached;
    const frame = await api.state(actualRunId, tick);
    assertFrameRun(frame);
    if (offline && frame.snapshot.tick !== tick) throw new Error(`录像缺少 tick ${tick} 的真实状态（服务返回 ${frame.snapshot.tick}）。`);
    cache.set(tick, frame);
    if (cache.size > 12) cache.delete(cache.keys().next().value!);
    return frame;
  };
  const title = get(root, '#broadcast-title');
  const clock = get(root, '#broadcast-clock');
  const subtitle = get(root, '#broadcast-caption');
  const seatList = get(root, '#broadcast-seats');
  const errorElement = get(root, '#broadcast-error');
  const setText = (element: Element, text: string): void => {
    if (element.textContent !== text) element.textContent = text;
  };
  let seats: Array<{ seat: typeof SEATS[number]; score: Text; model: Element; territories: Element; intent: Element }> = [];
  const paintLabels = (frame: StateFrame, caption: string): void => {
    setText(title, `${frame.run.track === 'strategy' ? '策略赛' : '外交赛'} / ${frame.snapshot.mapName}`);
    setText(clock, formatClock(frame.snapshot.tick));
    setText(subtitle, caption);
    if (seats.length !== frame.run.factionCount) {
      const owners = SEATS.slice(0, frame.run.factionCount);
      seatList.innerHTML = owners.map((seat, index) => `<article class="broadcast-seat seat-${seat}"><div class="broadcast-seat-title"><span class="seat-token">${String.fromCharCode(65 + index)}</span><strong>${SEAT_LABELS[seat]}</strong><span data-score>0<small>分</small></span></div><h2></h2><p class="broadcast-territories"></p><div class="broadcast-intent"><span>模型自述</span><p></p></div></article>`).join('');
      seats = owners.map((seat, index) => {
        const card = seatList.children[index]!;
        return { seat, score: get(card, '[data-score]').firstChild as Text, model: get(card, 'h2'), territories: get(card, '.broadcast-territories'), intent: get(card, '.broadcast-intent p') };
      });
    }
    seats.forEach(({ seat, score, model, territories, intent }, index) => {
      const decision = frame.decisions.findLast(item => item.owner === seat);
      const points = String(frame.snapshot.scores[seat] ?? 0);
      if (score.data !== points) score.data = points;
      setText(model, modelLabel(frame.run.models[index] ?? '', models));
      setText(territories, `${frame.snapshot.territoryCounts[seat] ?? 0} 块领地`);
      setText(intent, decision?.intent || (decision?.status === 'waiting' ? '等待模型回复' : '本轮未提供战术说明'));
    });
  };
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // The attached catch prevents an unhandled rejection before the exporter attaches its observer.
  void ready.catch(() => undefined);
  const reportError = (error: unknown): void => {
    const message = errorMessage(error);
    renderApi.error = message;
    if (errorElement.hidden) errorElement.hidden = false;
    setText(errorElement, `真实战局无法渲染：${message}`);
  };
  const clearError = (): void => {
    if (!errorElement.hidden) errorElement.hidden = true;
    delete renderApi.error;
  };
  let latest: StateFrame | null = null;
  let timer = 0;
  let pollRequest: AbortController | null = null;
  const paintLive = (): void => {
    const shown = live?.presentation;
    if (!latest || !shown) return;
    paintLabels({ ...latest, ...shown }, '');
    if (live.caughtUp && ['completed', 'failed'].includes(latest.run.status)) clearInterval(timer);
  };
  const live: LivePlayback | null = offline ? null : new LivePlayback(battlefield, paintLive, error => {
    if (error) reportError(error); else clearError();
  });
  const renderApi: BroadcastRenderApi & { runId: string; sourceFingerprint: string } = {
    ready,
    runId: '',
    sourceFingerprint: '',
    canvasSelector: '[data-testid="broadcast-frame"]',
    async renderFrame(input: RenderFrameInput): Promise<void> {
      await ready;
      try {
        if (!Number.isFinite(input.gameTick) || input.gameTick < 0 || input.gameTick > maximum) throw new Error('请求的游戏时间超出已记录战局。');
        if (!Number.isFinite(input.frameTime) || input.frameTime < 0) throw new Error('必须提供有效的 frameTime 毫秒时钟。');
        const tick = Math.floor(input.gameTick);
        const fraction = input.gameTick - tick;
        const before = await readFrame(tick);
        // Read the next recorded state too: interpolate only between real adjacent ticks.
        const after = fraction > 0 && tick < maximum ? await readFrame(tick + 1) : before;
        const alpha = after.snapshot.tick === before.snapshot.tick + 1 ? fraction : 0;
        const discontinuity = lastSegment !== input.segment.id || tick < lastTick || tick > lastTick + 1;
        paintLabels(before, input.caption);
        battlefield.setFrame(before, { seek: discontinuity, clockMs: input.frameTime, alpha });
        lastTick = tick;
        lastSegment = input.segment.id;
        clearError();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      } catch (error) { reportError(error); throw error; }
    },
  };
  window.__STATE_AI_RENDER__ = renderApi;
  try {
    if (!requestedRunId) throw new Error('请通过 /broadcast?run=对局ID 或 /broadcast/对局ID 打开。');
    const [modelResult, initial] = await Promise.all([api.models(), api.state(requestedRunId, offline ? 0 : undefined)]);
    if (typeof initial.run.id !== 'string' || !initial.run.id.trim() || initial.run.id !== requestedRunId) throw new Error('实际战局与请求的对局不一致。');
    actualRunId = initial.run.id;
    const [detail, storyboard] = await Promise.all([api.detail(actualRunId), api.storyboard(actualRunId)]);
    if (detail.run.id !== actualRunId || storyboard.runId !== actualRunId) throw new Error('战局、比赛记录与已校验的节目脚本不属于同一对局。');
    if (typeof storyboard.sourceFingerprint !== 'string' || !storyboard.sourceFingerprint.trim()) throw new Error('已校验的节目脚本缺少真实战局指纹。');
    models = modelResult.models;
    maximum = detail.run.tick;
    if (offline && initial.snapshot.tick !== 0) throw new Error('录像没有初始真实状态。');
    cache.set(initial.snapshot.tick, initial);
    if (document.fonts) await document.fonts.ready;
    if (live) {
      latest = initial;
      live.update(initial, true);
      paintLive();
      if (!['completed', 'failed'].includes(initial.run.status)) {
        timer = window.setInterval(() => {
          if (pollRequest) return;
          const request = new AbortController();
          pollRequest = request;
          void api.state(actualRunId, undefined, request.signal).then(frame => {
            if (request.signal.aborted) return;
            assertFrameRun(frame);
            maximum = Math.max(maximum, frame.snapshot.tick);
            latest = frame;
            live.update(frame);
            paintLive();
            if (!live.error) clearError();
          }).catch(error => { if (!request.signal.aborted) reportError(error); }).finally(() => { pollRequest = null; });
        }, 1200);
      }
      window.addEventListener('pagehide', () => {
        clearInterval(timer);
        pollRequest?.abort();
        live.destroy();
        battlefield.destroy();
      }, { once: true });
    } else {
      paintLabels(initial, '');
      battlefield.setFrame(initial, { seek: true, clockMs: 0 });
    }
    renderApi.runId = initial.run.id;
    renderApi.sourceFingerprint = storyboard.sourceFingerprint;
    resolveReady();
  } catch (error) { reportError(error); rejectReady(error); }
}

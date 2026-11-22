import type { ConfidenceInterval } from '@state/evaluation/types';
import { api, ApiError, artifactUrl } from './api';
import type { CreateRunInput, CreateTournamentInput, DecisionSummary, ExportJob, ModelSummary, TournamentDetail, TournamentSummary, RoundDetail, RunDetail, RunEvent, RunSummary, Seat, StartBudget, StateFrame, Storyboard } from './api';
import { emptyState, get, h, icon, pretty, setContent } from './dom';
import { addStoryEvent, defaultModels, errorMessage, eventTitle, parseSeeds, formatClock, formatElapsed, formatStartBudgetUsd, formatUsd, isLive, modelLabel, recordedTick, RUN_LABELS, SEAT_LABELS, SEATS, startBudgetStopField, validateRun, visibleEvents } from './model';
import { Battlefield } from './renderer';
import { LivePlayback } from './live-playback';
import { ReplayPlayback, replayEventsBetween } from './replay';

type Screen = 'build' | 'watch' | 'replay' | 'studio';
const SCREENS: Array<{ id: Screen; label: string; glyph: 'flag' | 'play' | 'rewind' | 'film' }> = [
  { id: 'build', label: '建局', glyph: 'flag' }, { id: 'watch', label: '观战', glyph: 'play' },
  { id: 'replay', label: '回放', glyph: 'rewind' }, { id: 'studio', label: '节目台', glyph: 'film' },
];
const decisionLabels: Record<DecisionSummary['status'], string> = { waiting: '等待模型', received: '回复已封存', applied: '已执行', error: '请求异常', skipped: '本轮跳过' };
function updateText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
const newSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! || 1;
const dateLabel = (raw: string): string => { const date = new Date(raw); return Number.isNaN(date.valueOf()) ? raw : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); };

export class StateApp {
  private screen: Screen = 'build';
  private models: ModelSummary[] = [];
  private modelListRevision = 0;
  private runs: RunSummary[] = [];
  private runId = '';
  private detail: RunDetail | null = null;
  private frame: StateFrame | null = null;
  private runStatusHtml = '';
  private round: RoundDetail | null = null;
  private board: Storyboard | null = null;
  private selectedSegment = '';
  private activeSeat: Seat = 'player';
  private job: ExportJob | null = null;
  private battlefield: Battlefield | null = null;
  private livePlayback: LivePlayback | null = null;
  private watchRequest: AbortController | null = null;
  private watchEvents: { source: RunEvent[]; privateMessages: boolean; visible: RunEvent[]; end?: number; selection?: number } | null = null;
  private decisionView: { decisions: DecisionSummary[]; outcome: StateFrame['outcome']; waiting: boolean } | null = null;
  private readonly battleContent = new WeakMap<Element, string>();
  private poll = 0;
  private jobPoll = 0;
  private recordingPoll = 0;
  private recordingRequest: { controller: AbortController; interactive: boolean } | null = null;
  private tournamentPoll = 0;
  private tournaments: TournamentSummary[] = [];
  private tournamentDetail: TournamentDetail | null = null;
  private tournamentId = '';
  private replay: ReplayPlayback | null = null;
  private replayDetailRequest: AbortController | null = null;
  private replaySeekDraft: number | null = null;
  private replayMarkedTick: number | null = null;
  private roundRequest: { controller: AbortController; index: number } | null = null;
  private readonly replayRounds = new Map<number, RoundDetail>();
  private roundMessage = '';
  private speed = 1;
  private loadingFrame = false;
  private sequence = 0;
  private busy = false;
  private dirty = false;
  private pageError = '';
  private modelsError = '';
  private historyError = '';
  private notice = '';
  private audioUrl = '';
  private importedAssetId = '';
  private pendingSeek: { runId: string; tick: number } | null = null;
  private startBudgetRequest: AbortController | null = null;
  private startBudgetRevision = 0;
  private startBudgetNote = '';
  private resumeStartBudget: StartBudget | undefined;
  private config: CreateRunInput = { track: 'strategy', seed: newSeed(), durationSeconds: 300, factionCount: 4, models: [], disaster: false, budget: { maxCalls: 1000, maxCostUsd: 0 } };

  constructor(private readonly root: HTMLElement) {
    root.addEventListener('click', event => { void this.onClick(event); });
    root.addEventListener('change', event => { void this.onChange(event); });
    root.addEventListener('input', event => this.onInput(event));
    root.addEventListener('submit', event => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      if (form.id === 'build-form') void this.createRun();
      else if (form.id === 'model-form') void this.registerModel(form);
      else if (form.id === 'tournament-form') void this.createTournament();
    });
    window.addEventListener('popstate', () => { this.readRoute(); this.render(); });
  }
  async init(): Promise<void> {
    this.readRoute();
    this.shell();
    await this.refreshLists();
    this.render();
  }
  private readRoute(): void {
    const query = new URLSearchParams(location.search);
    this.screen = SCREENS.some(item => item.id === query.get('screen')) ? query.get('screen') as Screen : 'build';
    this.runId = query.get('run') ?? '';
  }
  private shell(): void {
    this.root.innerHTML = `<a class="skip-link" href="#workspace">跳到工作区</a>
      <header class="topbar"><a class="brand" href="?screen=build" data-screen="build" aria-label="STATE.AI 建局台"><span class="brand-stamp" aria-hidden="true">寸土<br>必争</span><span class="brand-word">STATE<span class="brand-dot">.</span>AI<small>模型对战实验室</small></span></a>
      <nav class="main-nav" aria-label="工作台">${SCREENS.map(item => `<a href="?screen=${item.id}" data-screen="${item.id}">${icon(item.glyph)}<span>${item.label}</span></a>`).join('')}</nav>
      <div class="local-mark"><span class="local-line"></span>本地工作区</div></header>
      <main id="workspace" class="workspace" tabindex="-1"><div id="page-notice" aria-live="polite"></div><div id="page"></div></main>
      <footer class="app-footer"><span>STATE.AI</span><span>真实引擎裁判 / 保存观察、输出与回执</span><span>寸土之间，见决策。</span></footer>
      <dialog id="model-dialog" class="model-dialog" aria-labelledby="model-dialog-title">
        <form id="model-form" method="post" autocomplete="off">
          <div class="sheet-title"><h2 id="model-dialog-title">接入 OpenAI 兼容模型</h2><button type="button" class="icon-button" data-action="close-model-dialog" aria-label="关闭模型接入">${icon('close')}</button></div>
          <div class="field"><label for="model-base-url">Base URL</label><input id="model-base-url" name="baseUrl" type="url" placeholder="https://api.example.com/v1" aria-describedby="model-base-note" required autofocus><p id="model-base-note" class="field-note">填写 API 根地址，通常以 /v1 结尾。公网服务填写 HTTPS，局域网服务可用 HTTP。</p></div>
          <div class="form-grid"><label class="field">模型 ID<input name="model" type="text" required></label><label class="field">显示名称（可选）<input name="label" type="text"></label></div>
          <div class="field"><label for="model-api-key">API Key</label><input id="model-api-key" name="apiKey" type="password" autocomplete="off" spellcheck="false" aria-describedby="model-key-note" required><p id="model-key-note" class="field-note">密钥由本地服务保存。接入时不会请求模型。</p></div>
          <fieldset><legend>单价（USD / 百万 tokens）</legend><div class="form-grid"><label class="field">输入单价<input name="inputUsdPerMillion" type="number" min="0" step="any" aria-describedby="model-price-note" required></label><label class="field">输出单价<input name="outputUsdPerMillion" type="number" min="0" step="any" aria-describedby="model-price-note" required></label></div><p id="model-price-note" class="field-note">两项必填。免费时请填写 0。</p></fieldset>
          <div class="form-grid"><label class="field">输出 token 上限（可选）<input name="maxOutputTokens" type="number" min="1" step="1"></label><label class="field">上限参数<select name="maxTokensParameter"><option value="max_completion_tokens">max_completion_tokens（默认）</option><option value="max_tokens">max_tokens（兼容旧端点）</option></select></label></div>
          <p id="model-error" class="inline-error" role="alert" hidden></p>
          <div class="form-submit"><span id="model-submit-status" role="status"></span><div class="dialog-actions"><button type="button" class="button" data-action="close-model-dialog">取消</button><button type="submit" class="button primary">保存接入${icon('check')}</button></div></div>
        </form>
      </dialog>`;
    const dialog = get<HTMLDialogElement>(this.root, '#model-dialog');
    dialog.addEventListener('close', () => {
      if (!dialog.open) get<HTMLInputElement>(dialog, '[name="apiKey"]').value = '';
    });
  }
  private async refreshLists(): Promise<void> {
    const revision = this.modelListRevision;
    const [models, runs] = await Promise.allSettled([api.models(), api.runs()]);
    if (revision === this.modelListRevision) {
      if (models.status === 'fulfilled') {
        this.models = models.value.models;
        this.modelsError = '';
        if (!this.config.models.length) this.config.models = defaultModels(this.models, this.config.factionCount);
      } else this.modelsError = errorMessage(models.reason);
    }
    if (runs.status === 'fulfilled') {
      this.runs = [...runs.value.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      this.historyError = '';
      if (!this.runId && this.runs.length) this.runId = this.runs[0]!.id;
    } else this.historyError = errorMessage(runs.reason);
  }
  private navigate(screen: Screen, runId = this.runId): void {
    this.screen = screen;
    this.runId = runId;
    const query = new URLSearchParams({ screen });
    if (runId) query.set('run', runId);
    history.pushState({}, '', `/?${query}`);
    this.pageError = '';
    this.notice = '';
    this.render();
  }
  private render(): void {
    this.sequence += 1;
    this.resetStartBudget();
    this.resumeStartBudget = undefined;
    clearInterval(this.poll);
    this.watchRequest?.abort();
    this.watchRequest = null;
    this.livePlayback?.destroy();
    this.livePlayback = null;
    this.watchEvents = null;
    this.decisionView = null;
    clearInterval(this.jobPoll);
    clearTimeout(this.recordingPoll);
    this.recordingPoll = 0;
    this.recordingRequest?.controller.abort();
    this.recordingRequest = null;
    clearInterval(this.tournamentPoll);
    this.root.querySelector<HTMLDialogElement>('#model-dialog[open]')?.close();
    this.audioUrl = '';
    this.importedAssetId = '';
    this.job = null;
    this.replayDetailRequest?.abort();
    this.replayDetailRequest = null;
    this.replay?.destroy();
    this.replay = null;
    this.replaySeekDraft = null;
    this.replayMarkedTick = null;
    this.cancelRoundRequest();
    this.replayRounds.clear();
    this.roundMessage = '';
    this.battlefield?.destroy();
    this.battlefield = null;
    this.detail = null;
    this.frame = null;
    this.runStatusHtml = '';
    this.loadingFrame = false;
    this.round = null;
    this.board = null;
    this.dirty = false;
    this.pageError = '';
    this.root.querySelectorAll<HTMLAnchorElement>('[data-screen]').forEach(link => {
      link.classList.toggle('active', link.dataset.screen === this.screen);
      if (link.dataset.screen === this.screen) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    if (this.screen === 'build') this.renderBuild(); else this.renderRunScreen();
    this.showNotice();
  }
  private showNotice(): void {
    const liveError = this.livePlayback?.error;
    const error = this.pageError || (liveError ? errorMessage(liveError) : '');
    this.setBattleContent('#page-notice', error ? `<div class="notice error" role="alert"><strong>操作未完成</strong><span>${h(error)}</span><button class="text-button" data-action="retry">重试</button></div>` : this.notice ? `<div class="notice success" role="status">${icon('check')}<span>${h(this.notice)}</span></div>` : '');
  }
  private budgetEstimate(): string {
    const { durationSeconds, factionCount, models } = this.config;
    const decisions = Math.ceil(durationSeconds * 10 / 20) * factionCount;
    const allBaseline = models.length === factionCount && models.every(id => {
      const model = this.models.find(candidate => candidate.id === id);
      return model?.kind === 'baseline' || model?.provider === 'baseline';
    });
    return `预计最多 ${decisions} 次决策（淘汰可能减少，HTTP 重试另计）。${allBaseline ? '预计 API 费用 $0。' : '整局费用取决于配置单价和实际用量。'}`;
  }
  private updateStartBudget(): void {
    const note = this.root.querySelector('#start-budget-note');
    if (!note) return;
    const text = this.startBudgetNote || '费用上限须覆盖所选模型的首轮预留。';
    if (note.textContent !== text) note.textContent = text;
    get<HTMLButtonElement>(this.root, '[data-action="quote-start-budget"]').disabled = this.startBudgetRequest !== null;
  }
  private resetStartBudget(note = ''): void {
    this.startBudgetRevision += 1;
    this.startBudgetRequest?.abort();
    this.startBudgetRequest = null;
    this.startBudgetNote = note;
    this.updateStartBudget();
  }
  private startBudgetText(budget: StartBudget): string {
    return `当前配置的首轮门槛为 ${budget.requiredCalls} 次决策，费用预留至少 ${formatStartBudgetUsd(budget.requiredCostUsd)}。`;
  }
  private async quoteStartBudget(): Promise<void> {
    if (this.screen !== 'build' || this.startBudgetRequest) return;
    this.readConfig();
    const [error] = validateRun(this.config, this.models);
    if (error) {
      this.startBudgetNote = `无法查询首轮门槛。${error}`;
      this.updateStartBudget();
      return;
    }
    const controller = new AbortController();
    this.startBudgetRequest = controller;
    this.startBudgetNote = '正在查询首轮门槛…';
    this.updateStartBudget();
    try {
      const startBudget = await api.startBudget(this.config, controller.signal);
      if (!controller.signal.aborted) this.startBudgetNote = this.startBudgetText(startBudget);
    } catch {
      if (!controller.signal.aborted) this.startBudgetNote = '暂时无法查询首轮门槛，请重试。';
    } finally {
      if (this.startBudgetRequest === controller) {
        this.startBudgetRequest = null;
        this.updateStartBudget();
      }
    }
  }
  private modelOptions(selected: string): string {
    const missing = selected && !this.models.some(model => model.id === selected) ? `<option value="${h(selected)}" selected disabled>${h(selected)} / 不可用</option>` : '';
    return `<option value="" ${selected ? '' : 'selected'}>选择参赛模型</option>${missing}${this.models.map(model => `<option value="${h(model.id)}" ${selected === model.id ? 'selected' : ''} ${model.available ? '' : 'disabled'}>${h(model.label)}${model.kind === 'baseline' ? ' / 内置基线' : ` / ${h(model.provider)}`}${model.available ? '' : ' / 未配置'}</option>`).join('')}`;
  }
  private renderBuild(): void {
    const config = this.config;
    const availableBaselines = this.models.filter(model => model.kind === 'baseline' && model.available);
    const selected = config.models.map(id => this.models.find(model => model.id === id));
    const allBaseline = selected.length > 0 && selected.every(model => model?.kind === 'baseline');
    setContent(this.root, '#page', `<div class="page-heading"><div><div class="section-kicker">对战实验室</div><h1>把决策交给模型。<br><span>把胜负留给战场。</span></h1><p>同一份规则，同一刻观察。每一步行动都有真实回执。</p></div><div class="heading-seal" aria-hidden="true">开局<br>见招</div></div>
      <div class="build-layout"><form id="build-form" class="setup-sheet" aria-label="创建对局">
        <div class="sheet-title"><h2>创建对局</h2><span class="meta">配置存入比赛记录</span></div>
        <fieldset class="track-field"><legend>比赛赛道</legend><div class="choice-row"><label class="choice ${config.track === 'strategy' ? 'selected' : ''}"><input type="radio" name="track" value="strategy" ${config.track === 'strategy' ? 'checked' : ''}><strong>策略赛</strong><span>调兵、经营与攻防</span></label><label class="choice ${config.track === 'diplomacy' ? 'selected' : ''}"><input type="radio" name="track" value="diplomacy" ${config.track === 'diplomacy' ? 'checked' : ''}><strong>外交赛</strong><span>三方起，交涉与盟约</span></label></div></fieldset>
        <div class="form-grid"><label class="field">参赛阵营<select name="factionCount">${[2, 3, 4].map(count => `<option value="${count}" ${config.factionCount === count ? 'selected' : ''} ${config.track === 'diplomacy' && count === 2 ? 'disabled' : ''}>${count} 方</option>`).join('')}</select></label><label class="field">游戏时长<select name="durationSeconds">${[180, 300, 480].map(duration => `<option value="${duration}" ${config.durationSeconds === duration ? 'selected' : ''}>${duration} 秒 / ${duration / 60} 分钟</option>`).join('')}</select></label></div>
        <fieldset class="models-field"><legend>模型入席</legend><div class="models-field-intro"><p class="field-note">每个阵营独立决策；允许同一基线或模型重复入席。</p><button type="button" class="button small" data-action="open-model-dialog" aria-haspopup="dialog" aria-controls="model-dialog">${icon('plus')}接入模型</button></div>
          <p id="model-added" role="status"></p>
          ${this.modelsError ? `<div class="inline-error">模型列表读取失败：${h(this.modelsError)} <button type="button" class="text-button" data-action="refresh-lists">重新连接</button></div>` : ''}
          ${SEATS.slice(0, config.factionCount).map((seat, index) => `<label class="seat-row seat-${seat}"><span class="seat-token">${String.fromCharCode(65 + index)}</span><span class="seat-name">${SEAT_LABELS[seat]}</span><select name="model-${index}" aria-label="${SEAT_LABELS[seat]}参赛模型">${this.modelOptions(config.models[index] ?? '')}</select></label>`).join('')}
        </fieldset><div class="form-grid"><label class="field">随机种子<div class="input-with-button"><input name="seed" type="number" min="1" max="4294967295" step="1" value="${config.seed}" required><button type="button" class="icon-button" data-action="new-seed" aria-label="生成新种子">${icon('refresh')}</button></div></label><label class="field">环境规则<span class="checkbox-field"><input type="checkbox" name="disaster" ${config.disaster ? 'checked' : ''}>启用原作天灾</span></label></div>
        <fieldset class="budget-field"><legend>预算边界</legend><div class="form-grid"><label class="field">决策次数上限<input name="maxCalls" type="number" min="1" step="1" value="${config.budget.maxCalls}" aria-describedby="start-budget-note start-budget-error" required></label><label class="field">USD 费用上限<input name="maxCostUsd" type="number" min="0" step="0.01" value="${config.budget.maxCostUsd}" aria-describedby="start-budget-note start-budget-error" required></label></div><div class="start-budget-row"><p id="start-budget-note" class="field-note" role="status"></p><button type="button" class="button small" data-action="quote-start-budget">查询首轮门槛</button></div><p id="start-budget-error" class="inline-error" role="alert" hidden></p><p id="budget-estimate" class="field-note">${this.budgetEstimate()}</p></fieldset>
        <div id="form-errors" class="inline-error" role="alert" hidden></div><div class="form-submit"><div><label class="checkbox-field"><input type="checkbox" name="recordVideo" ${config.recordVideo ? 'checked' : ''}>完赛后生成整局录像</label><p class="field-note">${allBaseline ? '当前为内置基线自对弈，无需模型凭证。' : '远程模型使用本地服务端配置的凭证。'}</p></div><button type="submit" class="button primary" ${this.busy || !this.models.some(model => model.available) ? 'disabled' : ''}>${this.busy ? '正在建局…' : '开局观战'}${icon('arrow')}</button></div>
      </form><aside class="build-aside"><div class="rule-stamp">同局<br>同规</div><h2>看见模型的<br>每一步取舍。</h2><p>真实地图、行军、升级与防御均交由原作引擎执行。模型的意图与实际结果分别记录。</p><ol class="method-list"><li><span>观察</span>冻结同一时刻的战局</li><li><span>决策</span>等待各方提交行动</li><li><span>裁判</span>逐条校验并执行指令</li><li><span>回放</span>保留原始输出与回执</li></ol><div class="baseline-note"><h3>无凭证也能开局</h3><p>${availableBaselines.length ? `服务已加载 ${availableBaselines.length} 个可用内置基线。` : this.modelsError ? '等待本地服务返回可用基线。' : '服务暂未返回可用基线。'}</p>${this.models.filter(model => !model.available).length ? `<details><summary>查看未配置的模型</summary>${this.models.filter(model => !model.available).map(model => `<p><strong>${h(model.label)}</strong><br>${h(model.unavailableReason ?? '服务端未启用此模型。')}</p>`).join('')}</details>` : ''}</div></aside></div>
      <section class="history-section" aria-labelledby="history-title"><div class="section-heading"><div><h2 id="history-title">对局档案</h2><p>仅列出本地服务保存的真实对局。</p></div><button class="button small" data-action="refresh-lists">${icon('refresh')}刷新</button></div><div id="history">${this.historyHtml()}</div></section><section class="tournament-section" aria-labelledby="tournament-title">${this.tournamentShell()}</section>`);
    this.updateStartBudget();
    void this.loadTournaments();
  }
  private async registerModel(form: HTMLFormElement): Promise<void> {
    const dialog = get<HTMLDialogElement>(this.root, '#model-dialog');
    const submit = get<HTMLButtonElement>(form, '[type="submit"]');
    if (this.screen !== 'build' || !dialog.open || submit.disabled || !form.reportValidity()) return;
    const errorElement = get<HTMLElement>(form, '#model-error');
    const status = get<HTMLElement>(form, '#model-submit-status');
    const data = new FormData(form);
    const value = (name: string): string => String(data.get(name) ?? '').trim();
    const model = value('model');
    const apiKey = value('apiKey');
    const baseUrl = value('baseUrl');
    try {
      const authority = /^https?:\/\/([^/?#]+)/i.exec(baseUrl)?.[1];
      if (!authority || authority.includes('@') || /[?#\s\\]/.test(baseUrl)) throw new Error();
      new URL(baseUrl);
    } catch {
      errorElement.textContent = '请填写不含凭据、查询参数或片段的 HTTP(S) API 根地址。';
      errorElement.hidden = false;
      get<HTMLInputElement>(form, '[name="baseUrl"]').focus();
      return;
    }
    if (!model || !apiKey) {
      errorElement.textContent = '请填写模型 ID 和 API Key。';
      errorElement.hidden = false;
      return;
    }
    const maxOutputTokens = value('maxOutputTokens');
    errorElement.hidden = true;
    submit.disabled = true;
    status.textContent = '正在保存接入…';
    try {
      const { model: registered } = await api.registerModel({
        baseUrl, model, apiKey, label: value('label') || undefined,
        inputUsdPerMillion: Number(value('inputUsdPerMillion')), outputUsdPerMillion: Number(value('outputUsdPerMillion')),
        maxOutputTokens: maxOutputTokens ? Number(maxOutputTokens) : undefined,
        maxTokensParameter: value('maxTokensParameter') === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens',
      });
      form.reset();
      if (dialog.open) dialog.close();
      this.modelListRevision += 1;
      const index = this.models.findIndex(candidate => candidate.id === registered.id);
      if (index >= 0) this.models[index] = registered;
      else this.models.push(registered);
      if (this.screen !== 'build') return;
      this.resetStartBudget();
      this.root.querySelectorAll<HTMLSelectElement>('#build-form .seat-row select').forEach(select => {
        select.innerHTML = this.modelOptions(select.value);
      });
      const roster = this.root.querySelector('#tournament-form .roster-options');
      if (roster) {
        const selected = Array.from(roster.querySelectorAll<HTMLInputElement>('input:checked'), field => field.value);
        roster.innerHTML = this.rosterOptions(selected);
      }
      const start = get<HTMLButtonElement>(this.root, '#build-form [type="submit"]');
      start.disabled = this.busy || !this.models.some(candidate => candidate.available);
      get(this.root, '#model-added').textContent = `${registered.label} 已接入。请选择要使用它的参赛阵营。`;
    } catch (error) {
      const code = error instanceof ApiError ? error.status : undefined;
      // A rejected request can contain credentials. Only display local messages.
      errorElement.textContent = code === 400 || code === 422
        ? '接入参数无效。请核对地址、模型 ID、密钥和单价。'
        : code === 409 ? '此模型接入已存在。请刷新模型列表。'
        : code ? `保存接入失败（HTTP ${code}）。请重试。` : '无法保存接入。请检查本地服务后重试。';
      errorElement.hidden = false;
    } finally {
      submit.disabled = false;
      status.textContent = '';
    }
  }
  private rosterOptions(selected = this.models.filter(model => model.available && model.kind === 'baseline').map(model => model.id)): string {
    return this.models.map(model => `<label><input type="checkbox" name="roster" value="${h(model.id)}" ${selected.includes(model.id) ? 'checked' : ''} ${model.available ? '' : 'disabled'}><span>${h(model.label)}<small>${model.available ? model.kind === 'baseline' ? '内置基线' : h(model.provider) : '未配置'}</small></span></label>`).join('');
  }
  private tournamentShell(): string {
    return `<div class="section-heading"><div><h2 id="tournament-title">批量赛程与统计</h2><p>用固定种子与换座位赛程比较模型。统计来自已完成的真实比赛。</p></div></div><div class="tournament-layout"><form id="tournament-form" class="tournament-form"><fieldset><legend>参赛模型集合</legend><div class="roster-options">${this.rosterOptions()}</div><p class="field-note">模型 ID 唯一；集合中模型数量须不少于每局阵营数。</p></fieldset><div class="form-grid"><label class="field">赛道<select name="batch-track"><option value="strategy">策略赛</option><option value="diplomacy">外交赛</option></select></label><label class="field">每局阵营<select name="batch-factions"><option value="2">2 方</option><option value="3">3 方</option><option value="4">4 方</option></select></label><label class="field">游戏时长<select name="batch-duration"><option value="180">180 秒</option><option value="300" selected>300 秒</option><option value="480">480 秒</option></select></label><label class="field">每种配置重复次数<input name="batch-repetitions" type="number" min="1" max="100" step="1" value="1" required></label></div><label class="field">种子列表<textarea name="batch-seeds" rows="2" required>${this.config.seed}</textarea><span class="field-note">逗号或空格分隔。相同种子用于平衡座位比较。</span></label><label class="field">换座位方式<select name="batch-policy"><option value="balanced-rotations">平衡轮换</option><option value="full-permutations">完整排列</option></select></label><div class="form-grid"><label class="field">批次总决策数上限<input name="batch-calls" type="number" min="1" step="1" value="10000" required></label><label class="field">批次总 USD 预算<input name="batch-cost" type="number" min="0" step="0.01" value="0" required></label><label class="field">每局决策数上限<input name="batch-run-calls" type="number" min="1" step="1" value="1000" required></label><label class="field">每局 USD 预算<input name="batch-run-cost" type="number" min="0" step="0.01" value="0" required></label></div><label class="checkbox-field"><input name="batch-disaster" type="checkbox">启用原作天灾</label><label class="checkbox-field development-checkbox"><input name="allow-development" type="checkbox"><span>允许开发试跑<span class="field-note">当前代码未冻结时，显式标记为开发批次；不作为正式基准。</span></span></label><p class="field-note">正式批次要求干净 Git HEAD，服务端冻结规则与协议。决策数与 HTTP 请求、重试次数分别记录。</p><div id="tournament-error" class="inline-error" role="alert" hidden></div><button class="button" type="submit">创建批次${icon('arrow')}</button></form><div class="tournament-results"><label class="field">选择已保存批次<select name="tournament-picker"><option value="">正在读取批次…</option></select></label><div id="tournament-report">${emptyState('尚无已选批次', '创建一组真实赛程后，查看完成进度和统计。')}</div></div></div>`;
  }
  private async loadTournaments(): Promise<void> {
    clearInterval(this.tournamentPoll);
    try {
      const { tournaments } = await api.tournaments();
      if (this.screen !== 'build') return;
      this.tournaments = tournaments;
      if (!this.tournamentId && tournaments.length) this.tournamentId = tournaments[0]!.id;
      this.updateTournamentPicker();
      if (this.tournamentId) await this.loadTournamentDetail();
      let polling = false;
      this.tournamentPoll = window.setInterval(() => {
        if (polling || this.screen !== 'build' || !this.tournamentId) return;
        polling = true;
        void this.loadTournamentDetail().finally(() => { polling = false; });
      }, 1800);
    } catch (error) { if (this.screen === 'build') setContent(this.root, '#tournament-report', `<p class="inline-error">批次列表读取失败：${h(errorMessage(error))}</p>`); }
  }
  private updateTournamentPicker(): void {
    setContent(this.root, '[name="tournament-picker"]', `<option value="">选择真实批次</option>${this.tournaments.map(tournament => `<option value="${h(tournament.id)}" ${tournament.id === this.tournamentId ? 'selected' : ''}>${h(tournament.id)} / ${tournament.completedGames}/${tournament.totalGames}${tournament.development ? ' / 开发试跑' : ''}</option>`).join('')}`);
  }
  private async loadTournamentDetail(): Promise<void> {
    const id = this.tournamentId;
    try {
      const { tournament } = await api.tournament(id);
      if (this.screen !== 'build' || id !== this.tournamentId) return;
      this.tournamentDetail = tournament;
      this.updateTournamentReport();
    } catch (error) { if (this.screen === 'build' && id === this.tournamentId) setContent(this.root, '#tournament-report', `<p class="inline-error">批次读取失败：${h(errorMessage(error))}</p>`); }
  }
  private updateTournamentReport(): void {
    const tournament = this.tournamentDetail;
    if (!tournament) return;
    const percent = (value: number | null): string => value === null ? '未知' : `${(value * 100).toFixed(1)}%`;
    const intervalHtml = (interval: ConfidenceInterval): string => {
      const status = { insufficient: '样本不足', limited: '样本有限', estimated: '已估计区间' }[interval.status];
      const range = interval.lower === null || interval.upper === null ? '样本不足，不估计区间' : `${percent(interval.lower)} - ${percent(interval.upper)}`;
      return `<small>${range}</small><small>${status} / ${interval.clusterCount} 个地图种子组 / ${interval.sampleCount} 个样本</small>${interval.warning ? `<small>${h(interval.warning)}</small>` : ''}`;
    };
    const groups = tournament.report.groups;
    setContent(this.root, '#tournament-report', `<div class="batch-summary"><div><span class="status status-${tournament.status}">${RUN_LABELS[tournament.status]}</span>${tournament.development ? '<span class="development-label">开发试跑</span>' : '<span class="meta">正式基准</span>'}</div><strong>${tournament.completedGames}<span> / ${tournament.totalGames} 场完成</span></strong><p>剩余 ${Math.max(0, tournament.totalGames - tournament.completedGames)} 场 / ${tournament.calls} 次决策 / HTTP 尝试 ${tournament.httpAttempts ?? '未提供'} / ${formatUsd(tournament.costUsd)}</p><div class="row-actions"><button class="button small" type="button" data-action="toggle-tournament" ${['paused', 'running', 'queued'].includes(tournament.status) ? '' : 'disabled'}>${icon(tournament.status === 'paused' ? 'play' : 'pause')}${tournament.status === 'paused' ? '继续批次' : '暂停批次'}</button></div>${tournament.error ? `<p class="inline-error">${h(tournament.error)}</p>` : ''}</div>${groups.length ? groups.map(group => `<section class="statistics-group"><h3>${group.track === 'strategy' ? '策略赛' : '外交赛'} / ${group.factionCount} 方 / ${group.durationSeconds} 秒</h3><p class="field-note">${group.completedGames} 场有效比赛 / ${group.mapGroups} 个地图种子组 / 协议 ${h(group.profile.protocolVersion)}</p><div class="table-scroll"><table class="statistics-table"><thead><tr><th>模型</th><th>场次</th><th>胜 / 并列</th><th>平均名次</th><th>冠军份额 / 95% CI</th><th>非法动作率</th><th>费用</th></tr></thead><tbody>${group.models.map(model => `<tr><td><strong>${h(model.label)}</strong></td><td>${model.games}</td><td>${model.wins} / ${model.ties}</td><td>${model.avgRank === null ? '未知' : model.avgRank.toFixed(2)}</td><td>${percent(model.championShare)}${intervalHtml(model.championShareInterval)}</td><td>${percent(model.invalidActionRate)}</td><td>${formatUsd(model.costUsd)}</td></tr>`).join('')}</tbody></table></div>${group.pairedComparisons.length ? `<details class="batch-runs"><summary>配对比较 / ${group.pairedComparisons.length} 组</summary>${group.pairedComparisons.map(comparison => `<div class="statistics-group"><h3>${comparison.modelIds.map(id => h(group.models.find(model => model.modelId === id)?.label ?? modelLabel(id, this.models))).join(' / ')}</h3><p class="field-note">${comparison.completePairs} 组完整配对 / ${comparison.incompletePairs} 组不完整配对 / ${comparison.mapGroups} 个地图种子组</p><div class="table-scroll"><table class="statistics-table"><thead><tr><th>模型</th><th>对战得分</th><th>平均得分 / 95% CI</th></tr></thead><tbody>${comparison.models.map(model => `<tr><td><strong>${h(group.models.find(item => item.modelId === model.modelId)?.label ?? modelLabel(model.modelId, this.models))}</strong></td><td>${model.points}</td><td>${percent(model.score)}${intervalHtml(model.confidenceInterval)}</td></tr>`).join('')}</tbody></table></div></div>`).join('')}</details>` : ''}${group.warnings.map(warning => `<p class="field-note statistics-warning">${h(warning)}</p>`).join('')}</section>`).join('') : emptyState('还没有可统计的已完成比赛', '不会将失败、中断或未完成的对局计为策略败局。')}${tournament.report.excludedRecords.length ? `<p class="field-note">${tournament.report.excludedRecords.length} 条比赛记录未纳入统计。</p>` : ''}<details class="batch-runs"><summary>查看批次实际对局 / ${tournament.runIds.length} 场</summary>${tournament.games.filter(game => game.runId).map(game => `<button type="button" class="text-button" data-action="open-run" data-run="${h(game.runId)}" data-target="${game.status === 'completed' ? 'replay' : 'watch'}">${h(game.runId)} / ${RUN_LABELS[game.status as RunSummary['status']] ?? game.status}${icon('arrow')}</button>`).join('')}</details>`);
  }
  private async createTournament(): Promise<void> {
    if (this.busy || this.screen !== 'build') return;
    const form = get<HTMLFormElement>(this.root, '#tournament-form');
    const errorElement = get<HTMLElement>(this.root, '#tournament-error');
    try {
      const data = new FormData(form);
      const input: CreateTournamentInput = {
        models: data.getAll('roster').map(String), seeds: parseSeeds(String(data.get('batch-seeds'))),
        track: data.get('batch-track') === 'diplomacy' ? 'diplomacy' : 'strategy',
        factionCount: Number(data.get('batch-factions')) as 2 | 3 | 4,
        durationSeconds: Number(data.get('batch-duration')) as 180 | 300 | 480,
        repetitions: Number(data.get('batch-repetitions')), seatPolicy: data.get('batch-policy') === 'full-permutations' ? 'full-permutations' : 'balanced-rotations',
        disaster: data.get('batch-disaster') === 'on', allowDevelopment: data.get('allow-development') === 'on',
        budget: { maxCalls: Number(data.get('batch-calls')), maxCostUsd: Number(data.get('batch-cost')) },
        runBudget: { maxCalls: Number(data.get('batch-run-calls')), maxCostUsd: Number(data.get('batch-run-cost')) },
      };
      if (input.models.length < input.factionCount) throw new Error('参赛模型集合数量须不少于每局阵营数。');
      if (input.track === 'diplomacy' && input.factionCount < 3) throw new Error('外交批次需要至少三方参赛。');
      this.busy = true;
      get<HTMLButtonElement>(form, '[type="submit"]').disabled = true;
      errorElement.hidden = true;
      const { tournament } = await api.createTournament(input);
      this.tournamentId = tournament.id;
      if (this.screen !== 'build') return;
      this.tournaments.unshift(tournament);
      this.updateTournamentPicker();
      await this.loadTournamentDetail();
      this.notice = '真实批次已创建。'; this.showNotice();
    } catch (error) { errorElement.hidden = false; errorElement.textContent = errorMessage(error); }
    finally { this.busy = false; const submit = form.querySelector<HTMLButtonElement>('[type="submit"]'); if (submit) submit.disabled = false; }
  }
  private historyHtml(): string {
    if (this.historyError) return `<div class="inline-error" role="alert">对局档案读取失败：${h(this.historyError)}</div>`;
    if (!this.runs.length) return emptyState('还没有对局记录', '选择参赛模型并开局，真实比赛会保存在这里。');
    return `<div class="table-scroll"><table class="history-table"><thead><tr><th>对局 / 时间</th><th>赛道与阵容</th><th>状态</th><th>游戏时间</th><th>决策 / 费用</th><th><span class="sr-only">查看对局</span></th></tr></thead><tbody>${this.runs.map(run => `<tr><td><strong class="run-code">${h(run.id)}</strong><small>${h(dateLabel(run.createdAt))} / seed ${run.seed}</small></td><td>${run.track === 'strategy' ? '策略赛' : '外交赛'} / ${run.factionCount} 方<small>${run.models.map(id => h(modelLabel(id, this.models))).join('、')}</small></td><td><span class="status status-${run.status}">${RUN_LABELS[run.status]}</span></td><td class="numeric">${formatClock(run.tick)} / ${formatClock(run.durationSeconds * 10)}</td><td class="numeric">${run.calls} 次<small>${formatUsd(run.costUsd)}</small></td><td><div class="row-actions"><button class="text-button" data-action="open-run" data-run="${h(run.id)}" data-target="${isLive(run) || run.status === 'paused' ? 'watch' : 'replay'}">${isLive(run) || run.status === 'paused' ? '观战' : '回放'}${icon('arrow')}</button>${run.status === 'completed' ? `<button class="text-button recording-history" data-action="open-run" data-run="${h(run.id)}" data-target="watch">录像</button>` : ''}<button class="text-button" data-action="open-run" data-run="${h(run.id)}" data-target="studio">节目</button></div></td></tr>`).join('')}</tbody></table></div>`;
  }
  private readConfig(): void {
    const form = this.root.querySelector<HTMLFormElement>('#build-form');
    if (!form) return;
    const data = new FormData(form);
    const count = Number(data.get('factionCount')) as 2 | 3 | 4;
    this.config = {
      track: data.get('track') === 'diplomacy' ? 'diplomacy' : 'strategy', seed: Number(data.get('seed')),
      durationSeconds: Number(data.get('durationSeconds')) as 180 | 300 | 480, factionCount: count,
      models: Array.from({ length: count }, (_, index) => String(data.get(`model-${index}`) ?? this.config.models[index] ?? '')),
      disaster: data.get('disaster') === 'on', budget: { maxCalls: Number(data.get('maxCalls')), maxCostUsd: Number(data.get('maxCostUsd')) },
      recordVideo: data.has('recordVideo'),
    };
  }
  private clearStartBudgetError(): void {
    const error = get(this.root, '#start-budget-error');
    error.textContent = '';
    error.hidden = true;
  }
  private showStartBudgetError(startBudget?: StartBudget): void {
    const { maxCalls, maxCostUsd } = this.config.budget;
    const callsLow = startBudget && maxCalls < startBudget.requiredCalls;
    const costLow = startBudget && maxCostUsd < startBudget.requiredCostUsd;
    if (startBudget) {
      this.resetStartBudget(this.startBudgetText(startBudget));
      if (!callsLow && !costLow) return;
    }
    const messages = ['开局预算不足。'];
    if (callsLow) messages.push(`决策次数上限至少须为 ${startBudget.requiredCalls} 次。`);
    if (costLow) messages.push(`USD 费用上限至少须为 ${formatStartBudgetUsd(startBudget.requiredCostUsd)}。`);
    if (!startBudget) messages.push('请查询首轮门槛并调整预算。');
    const error = get(this.root, '#start-budget-error');
    error.textContent = messages.join('');
    error.hidden = false;
    get<HTMLInputElement>(this.root, `[name="${callsLow ? 'maxCalls' : 'maxCostUsd'}"]`).focus();
  }
  private buildFieldEdited(name: string): void {
    this.clearStartBudgetError();
    if (name !== 'maxCalls' && name !== 'maxCostUsd') this.resetStartBudget();
  }
  private async createRun(): Promise<void> {
    if (this.screen !== 'build' || this.busy) return;
    this.readConfig();
    this.clearStartBudgetError();
    const errors = validateRun(this.config, this.models);
    const errorElement = get<HTMLElement>(this.root, '#form-errors');
    errorElement.hidden = !errors.length;
    errorElement.innerHTML = errors.map(error => `<p>${h(error)}</p>`).join('');
    if (errors.length) { errorElement.scrollIntoView({ block: 'nearest' }); return; }
    const sequence = this.sequence;
    const budgetRevision = this.startBudgetRevision;
    this.busy = true;
    const submit = get<HTMLButtonElement>(this.root, '#build-form [type="submit"]');
    submit.disabled = true;
    submit.textContent = '正在建局…';
    try {
      const { run } = await api.createRun(this.config);
      this.runs.unshift(run);
      if (sequence === this.sequence) this.navigate('watch', run.id);
    } catch (error) {
      if (sequence !== this.sequence) return;
      if (error instanceof ApiError && error.code === 'START_BUDGET_TOO_LOW') {
        if (budgetRevision === this.startBudgetRevision) {
          this.readConfig();
          this.showStartBudgetError(error.startBudget);
        }
      } else {
        this.pageError = errorMessage(error);
        this.showNotice();
      }
    } finally {
      this.busy = false;
      const currentSubmit = this.root.querySelector<HTMLButtonElement>('#build-form [type="submit"]');
      if (currentSubmit) {
        currentSubmit.disabled = !this.models.some(model => model.available);
        currentSubmit.innerHTML = `开局观战${icon('arrow')}`;
      }
    }
  }

  private renderRunScreen(): void {
    const titles = { watch: ['观战台', '每一次调兵，都有来处。'], replay: ['回放台', '回到决策发生的那一刻。'], studio: ['节目工作台', '用真实战局，讲一场好比赛。'] };
    const [title, subtitle] = titles[this.screen as 'watch' | 'replay' | 'studio'];
    setContent(this.root, '#page', `<div class="run-page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div><label class="run-picker">当前对局<select name="run-picker" aria-label="选择真实对局"><option value="">选择一场对局</option>${this.runs.map(run => `<option value="${h(run.id)}" ${this.runId === run.id ? 'selected' : ''}>${h(run.id)} / ${RUN_LABELS[run.status]}</option>`).join('')}${this.runId && !this.runs.some(run => run.id === this.runId) ? `<option value="${h(this.runId)}" selected>${h(this.runId)}</option>` : ''}</select></label></div>
      ${!this.runId ? emptyState('先选一场真实对局', '在建局台创建比赛，或从已有档案进入观战、回放与节目台。') : this.screen === 'studio' ? this.studioShell() : this.battleShell()}`);
    if (!this.runId) return;
    const canvas = this.root.querySelector<HTMLCanvasElement>('#battlefield');
    if (canvas) this.battlefield = new Battlefield(canvas);
    if (this.screen === 'watch' && this.battlefield) {
      this.livePlayback = new LivePlayback(this.battlefield, () => {
        this.updateBattle();
        this.stopWatchPollWhenCaughtUp();
      }, () => this.showNotice());
    }
    void this.loadRunScreen();
    if (this.screen === 'watch') this.poll = window.setInterval(() => { if (!this.loadingFrame) void this.refreshLive(); }, 1200);
  }
  private battleShell(): string {
    return `<section class="battle-desk" aria-label="真实对局"><div id="run-status" class="run-status-bar"><span>正在读取比赛记录…</span></div><p id="run-budget-stop" class="inline-error run-budget-stop" hidden></p><div id="scoreboard" class="scoreboard" aria-label="各方比分"></div>
      <div class="battle-layout"><div class="map-panel"><div class="map-title"><span id="map-name">真实战场</span><div class="map-tools"><button class="icon-button" data-action="zoom-in" aria-label="放大地图">${icon('plus')}</button><button class="icon-button" data-action="zoom-out" aria-label="缩小地图">${icon('minus')}</button><button class="icon-button" data-action="reset-camera" aria-label="复位地图">${icon('expand')}</button></div></div><div class="map-stage" data-full-bleed><canvas id="battlefield" class="map-canvas" aria-label="由原作 CanvasRenderer 绘制的真实战局" hidden></canvas><div id="map-empty" class="map-empty">${icon('flag')}<p>正在读取原作引擎快照…</p></div></div><div id="map-caption" class="map-caption">地图与战斗规则由原作引擎提供</div></div>
      <aside class="decision-panel" aria-label="模型决策"><div class="panel-heading"><h2>${this.screen === 'replay' ? '本轮决策' : '模型决策'}</h2><span id="decision-round" class="meta"></span></div><div id="decisions">${emptyState('等待读取', '收到真实决策后显示意图与执行回执。')}</div></aside></div>
      <div id="timeline" class="timeline-panel" aria-label="事件时间线">${this.screen === 'watch' ? this.watchTimelineShell() : ''}</div></section>
      ${this.screen === 'replay' ? '<section id="round-inspector" class="round-inspector" aria-label="逐轮观察与输出"></section>' : ''}
      ${this.recordingShell()}`;
  }
  private recordingShell(): string {
    return `<section id="match-recording" class="export-panel" aria-labelledby="recording-title" hidden>
      <div class="section-heading"><div><h2 id="recording-title">整局录像</h2><p>游戏时间 1× / 1920 × 1080 / 30 fps / 静音 MP4</p><p>本地需要 FFmpeg，以及 Edge 或 Chromium 浏览器。</p></div></div>
      <div class="job-status"><div><strong id="recording-status" role="status" tabindex="-1"></strong><span id="recording-stage" class="meta"></span></div><span id="recording-percent" class="numeric" aria-hidden="true"></span></div>
      <div id="recording-job"></div>
    </section>`;
  }
  private syncRecording(run: RunSummary): void {
    const panel = get(this.root, '#match-recording');
    const completed = run.status === 'completed';
    panel.hidden = !(completed || this.screen === 'watch' && run.recordVideo && run.status !== 'failed');
    if (completed) {
      this.showRecording('正在读取录像状态…');
      void this.loadRecording();
    } else if (!panel.hidden) this.showRecording('完赛后自动生成录像。');
  }
  private async loadRecording(start = false, interactive = false): Promise<void> {
    const run = this.screen === 'replay' ? this.detail?.run : this.frame?.run;
    if ((this.screen !== 'watch' && this.screen !== 'replay') || run?.status !== 'completed') return;
    const pending = this.recordingRequest;
    if (pending && (!interactive || pending.interactive)) return;
    pending?.controller.abort();
    clearTimeout(this.recordingPoll);
    this.recordingPoll = 0;
    const request = { controller: new AbortController(), interactive };
    this.recordingRequest = request;
    const { signal } = request.controller;
    if (interactive) this.showRecording(start ? '正在提交录像任务…' : '正在读取录像状态…');
    try {
      const { job } = await (start ? api.createRecording(run.id, signal) : api.recording(run.id, signal));
      if (signal.aborted) return;
      this.updateRecording(job, run.recordVideo === true);
      if (job?.status === 'queued' || job?.status === 'running' || (!job && run.recordVideo)) {
        this.recordingPoll = window.setTimeout(() => { void this.loadRecording(); }, 1200);
      }
    } catch (error) {
      if (signal.aborted) return;
      this.showRecording(start ? '录像提交失败' : '录像状态读取失败', `<p class="inline-error" role="alert">${h(errorMessage(error))}</p>${this.recordingAction(start ? '重试录像' : '重新读取状态', start)}`);
    } finally {
      if (this.recordingRequest === request) this.recordingRequest = null;
    }
  }
  private updateRecording(job: ExportJob | null, automatic: boolean): void {
    if (!job) {
      const status = automatic ? '正在等待自动录像…' : '尚未生成录像';
      if (get(this.root, '#recording-status').textContent !== status) {
        this.showRecording(status, this.recordingAction('生成整局录像', true));
      }
      return;
    }
    const labels = { queued: '等待生成录像', running: '正在生成录像', completed: '录像已完成', failed: '录像生成失败', cancelled: '录像已取消' };
    const stages: Record<string, string> = { tools: '准备录制工具', frames: '渲染战局画面', encoding: '编码 MP4', verification: '校验 MP4', publishing: '保存录像' };
    const progress = Math.max(0, Math.min(1, job.progress));
    const percent = `${Math.round(progress * 100)}%`;
    const download = job.status === 'completed' && (job.artifacts ?? [])
      .filter(artifact => artifact.mediaType === 'video/mp4' || /\.mp4$/i.test(artifact.name))
      .map(artifact => artifactUrl(artifact.url)).find(Boolean);
    const retry = job.status === 'failed' || job.status === 'cancelled';
    let action = retry ? this.recordingAction('重试录像', true)
      : job.status === 'completed' ? this.recordingAction('重新读取状态', false) : '';
    if (download) {
      const url = new URL(download, window.location.origin);
      url.searchParams.set('inline', '1');
      const preview = url.pathname + url.search;
      if (this.root.querySelector('.recording-preview')?.getAttribute('src') === preview) return;
      action = `<video class="recording-preview" controls playsinline preload="none" aria-label="整局录像" src="${h(preview)}"></video>
        <div class="artifact-links"><a class="button small" href="${h(download)}" download>${icon('download')}下载 MP4</a></div>`;
    }
    const error = job.error || (job.status === 'completed' && !download ? '服务未返回可下载的 MP4。' : '');
    const stage = job.status === 'running' && job.stage ? stages[job.stage] : undefined;
    this.showRecording(labels[job.status], `<progress max="1" value="${progress}" aria-label="整局录像生成进度">${percent}</progress>${error ? `<p class="inline-error" role="alert">${h(error)}</p>` : ''}${action}`, stage, percent);
  }
  private showRecording(status: string, content = '', stage = '', percent = ''): void {
    const statusElement = get(this.root, '#recording-status');
    if (statusElement.textContent !== status) statusElement.textContent = status;
    get(this.root, '#recording-stage').textContent = stage;
    get(this.root, '#recording-percent').textContent = percent;
    const body = get(this.root, '#recording-job');
    if (body.contains(this.root.ownerDocument.activeElement)) statusElement.focus();
    body.innerHTML = content;
  }
  private recordingAction(label: string, start: boolean): string {
    return `<div class="artifact-links"><button class="button small" type="button" data-action="${start ? 'start-recording' : 'reload-recording'}">${icon(start ? 'film' : 'refresh')}${h(label)}</button></div>`;
  }
  private async loadRunScreen(): Promise<void> {
    if (this.screen === 'replay') { await this.loadReplay(); return; }
    if (!this.runId || this.loadingFrame) return;
    const sequence = this.sequence;
    const runId = this.runId;
    const request = this.screen === 'watch' ? new AbortController() : null;
    if (request) this.watchRequest = request;
    this.loadingFrame = true;
    try {
      const frame = await api.state(runId, undefined, request?.signal);
      if (sequence !== this.sequence) return;
      this.acceptFrame(frame, true);
      const detail = await api.detail(runId, request?.signal);
      if (sequence !== this.sequence) return;
      this.detail = detail;
      if (this.screen !== 'studio') this.updateBattle();
      this.pageError = '';
      if (this.screen === 'studio') {
        const board = await api.storyboard(runId);
        if (sequence !== this.sequence) return;
        this.board = board;
        this.selectedSegment = this.board.segments[0]?.id ?? '';
        this.updateStudio();
      }
      this.showNotice();
    } catch (error) {
      if (sequence !== this.sequence) return;
      this.pageError = errorMessage(error);
      setContent(this.root, '#map-empty', `${icon('flag')}<p>战局快照未加载</p><small>${h(this.pageError)}</small>`);
      this.showNotice();
    } finally {
      if (this.watchRequest === request) this.watchRequest = null;
      if (sequence === this.sequence) this.loadingFrame = false;
    }
  }
  private async loadReplay(): Promise<void> {
    if (!this.runId || this.replayDetailRequest) return;
    if (this.replay) {
      this.replay.seek(this.replay.seekTick ?? this.replay.tick ?? this.replay.maximum);
      return;
    }
    const id = this.runId;
    const initialTick = this.pendingSeek?.runId === id ? this.pendingSeek.tick : null;
    const request = new AbortController();
    this.replayDetailRequest = request;
    try {
      const detail = await api.detail(id, request.signal);
      if (this.replayDetailRequest !== request) return;
      this.pendingSeek = null;
      this.detail = detail;
      this.syncRecording(detail.run);
      if (SEATS.indexOf(this.activeSeat) >= detail.run.factionCount) this.activeSeat = 'player';
      this.replay = new ReplayPlayback(detail.run.tick, {
        load: (from, limit, signal) => api.replayFrames(id, from, limit, signal),
        frame: (frame, seek) => this.acceptReplayFrame(frame, seek),
        clock: tick => this.battlefield?.displayTime(tick),
        status: () => { this.updateReplayTimeline(); this.loadRoundForFrame(); },
        error: error => this.showReplayError(error),
      });
      this.replay.setSpeed(this.speed);
      this.renderReplayTimeline(detail);
      this.replay.seek(recordedTick(initialTick ?? detail.run.tick, detail.run.tick));
    } catch (error) {
      if (this.replayDetailRequest === request) this.showReplayError(error);
    } finally {
      if (this.replayDetailRequest === request) this.replayDetailRequest = null;
    }
  }
  private showReplayError(error: unknown): void {
    this.pageError = errorMessage(error);
    if (!this.frame) setContent(this.root, '#map-empty', `${icon('flag')}<p>战局快照未加载</p><small>${h(this.pageError)}</small>`);
    this.showNotice();
  }
  private acceptReplayFrame(frame: StateFrame, seek: boolean): void {
    const previous = this.frame;
    const events = seek || !previous || !this.detail ? [] : replayEventsBetween(this.detail.events, previous.snapshot.tick, frame.snapshot.tick);
    const next = { ...frame, events };
    if (seek || !previous || frame.run.status !== previous.run.status) {
      this.acceptFrame(next, seek || !previous);
    } else {
      this.frame = next;
      this.battlefield?.setFrame(next);
      const before = previous.snapshot, after = frame.snapshot;
      const scoresChanged = SEATS.some(seat => before.scores[seat] !== after.scores[seat]
        || before.territoryCounts[seat] !== after.territoryCounts[seat]
        || before.aliveOwners?.includes(seat) !== after.aliveOwners?.includes(seat));
      if (scoresChanged || frame.run !== previous.run || frame.decisions !== previous.decisions || frame.outcome !== previous.outcome
        || Math.floor(before.tick / 10) !== Math.floor(after.tick / 10)) this.updateBattle();
      else this.updateReplayTimeline();
    }
    if (this.pageError) { this.pageError = ''; this.showNotice(); }
  }
  private acceptFrame(frame: StateFrame, seek = false): void {
    const previous = this.frame?.run;
    this.frame = frame;
    if (this.livePlayback) this.livePlayback.update(frame, seek);
    else this.battlefield?.setFrame(frame, { seek });
    const index = this.runs.findIndex(run => run.id === frame.run.id);
    if (index >= 0) this.runs[index] = { ...this.runs[index], ...frame.run };
    else this.runs.unshift(frame.run);
    const picker = this.root.querySelector<HTMLSelectElement>('[name="run-picker"]');
    const option = Array.from(picker?.options ?? []).find(item => item.value === frame.run.id);
    const optionLabel = `${frame.run.id} / ${RUN_LABELS[frame.run.status]}`;
    if (option && option.textContent !== optionLabel) option.textContent = optionLabel;
    this.stopWatchPollWhenCaughtUp();
    const canvas = this.root.querySelector<HTMLCanvasElement>('#battlefield');
    if (canvas?.hidden) canvas.hidden = false;
    const empty = this.root.querySelector<HTMLElement>('#map-empty');
    if (empty && !empty.hidden) empty.hidden = true;
    if (this.screen !== 'studio') this.updateBattle();
    if (this.screen === 'watch' && (previous?.status !== frame.run.status || previous.recordVideo !== frame.run.recordVideo)) {
      this.syncRecording(frame.run);
    }
  }
  private stopWatchPollWhenCaughtUp(): void {
    if (this.livePlayback?.caughtUp && this.frame && ['completed', 'failed'].includes(this.frame.run.status)) clearInterval(this.poll);
  }
  private async refreshLive(): Promise<void> {
    if (!this.runId || this.screen !== 'watch' || this.loadingFrame) return;
    const sequence = this.sequence;
    const runId = this.runId;
    const request = new AbortController();
    this.watchRequest = request;
    this.loadingFrame = true;
    try {
      const frame = await api.state(runId, undefined, request.signal);
      if (sequence !== this.sequence) return;
      this.acceptFrame(frame);
      if (['completed', 'failed'].includes(frame.run.status) && this.detail?.run.status !== frame.run.status) {
        const detail = await api.detail(runId, request.signal);
        if (sequence !== this.sequence) return;
        this.detail = detail;
        this.updateBattle();
      }
      this.pageError = '';
      this.showNotice();
    } catch (error) { if (sequence === this.sequence) { this.pageError = errorMessage(error); this.showNotice(); } }
    finally {
      if (this.watchRequest === request) this.watchRequest = null;
      if (sequence === this.sequence) this.loadingFrame = false;
    }
  }
  private setBattleContent(selector: string, html: string): void {
    const element = get(this.root, selector);
    if (this.battleContent.get(element) === html) return;
    element.innerHTML = html;
    this.battleContent.set(element, html);
  }
  private updateBattle(): void {
    const frame = this.frame;
    if (!frame) return;
    const run = frame.run;
    const shown = this.livePlayback?.presentation ?? frame;
    const { snapshot, decisions } = shown;
    const paused = run.status === 'paused';
    const budgetStop = startBudgetStopField(run, this.resumeStartBudget);
    const pauseAction = budgetStop
      ? `<button class="button small" data-action="rebuild-budget">${icon('arrow')}调整预算后重开</button>`
      : `<button class="button small" data-action="toggle-pause" ${this.busy || !isLive(run) && !paused ? 'disabled' : ''}>${icon(paused ? 'play' : 'pause')}${paused ? '恢复比赛' : '暂停比赛'}</button>`;
    const statusHtml = `<div class="run-identity"><span class="status status-${run.status}">${RUN_LABELS[run.status]}</span><span class="run-code">${h(run.id)}</span><span>${run.track === 'strategy' ? '策略赛' : '外交赛'} / seed ${run.seed}</span></div><div class="clock-group"><div><small>游戏时钟</small><strong id="battle-clock">00:00<span></span></strong></div><div><small>实际耗时</small><strong id="battle-elapsed"></strong></div>${this.screen === 'watch' ? pauseAction : '<span class="replay-mark">历史记录</span>'}</div>`;
    if (this.runStatusHtml !== statusHtml) {
      const rebuildFocused = this.root.ownerDocument.activeElement?.matches('[data-action="rebuild-budget"]');
      setContent(this.root, '#run-status', statusHtml);
      this.runStatusHtml = statusHtml;
      if (rebuildFocused) this.root.querySelector<HTMLButtonElement>('[data-action="rebuild-budget"]')?.focus({ preventScroll: true });
    }
    updateText(get(this.root, '#battle-clock').firstChild!, formatClock(snapshot.tick));
    updateText(get(this.root, '#battle-clock span'), ` / ${formatClock(snapshot.durationTicks)}`);
    updateText(get(this.root, '#battle-elapsed'), formatElapsed(run.wallElapsedMs));
    const reason = get(this.root, '#run-budget-stop');
    if (reason.hidden !== !budgetStop) reason.hidden = !budgetStop;
    updateText(reason, budgetStop === 'maxCostUsd' ? `USD 费用上限（$${run.budget.maxCostUsd}）不足以预留所选模型的首轮费用。比赛尚未发起决策。`
      : budgetStop === 'maxCalls' ? `决策次数上限（${run.budget.maxCalls} 次）不足以覆盖当前阵容的首轮决策。比赛尚未发起决策。` : '');
    this.updateScores(run, snapshot, decisions);
    updateText(get(this.root, '#map-name'), snapshot.mapName);
    this.setBattleContent('#map-caption', `<span>${h(snapshot.geog?.regionLabel ?? '原作真实地图')} / ${snapshot.territories.length} 块领地</span><span>${run.calls} 次决策 / ${formatUsd(run.costUsd)}${run.httpAttempts === undefined ? '' : run.httpAttempts === null ? ' / HTTP 尝试次数未知' : ` / ${run.httpAttempts} 次 HTTP 尝试`}</span>`);
    const outcomes = shown.outcome ?? (this.screen === 'watch' && this.livePlayback?.caughtUp ? this.detail?.outcome : null);
    const waiting = run.status === 'waiting' && (!this.livePlayback || this.livePlayback.caughtUp);
    this.updateBattleDecisions(run, decisions, outcomes, waiting);
    if (this.screen === 'watch') this.updateWatchTimeline(frame, snapshot.tick);
    else this.updateReplayTimeline();
  }
  private updateScores(run: RunSummary, snapshot: StateFrame['snapshot'], decisions: DecisionSummary[]): void {
    const scoreboard = get(this.root, '#scoreboard');
    const owners = SEATS.slice(0, run.factionCount);
    if (scoreboard.childElementCount !== owners.length) {
      scoreboard.innerHTML = owners.map((seat, index) => `<div class="score-seat seat-${seat}"><div class="score-seat-top"><span class="seat-token">${String.fromCharCode(65 + index)}</span><span>${SEAT_LABELS[seat]}</span><small></small></div><div class="score-value"><strong></strong><span>控地分</span><span class="territory-count"></span></div><p></p></div>`).join('');
    }
    owners.forEach((seat, index) => {
      const card = scoreboard.children[index]!;
      const decision = decisions.findLast(item => item.owner === seat);
      const alive = !snapshot.aliveOwners || snapshot.aliveOwners.includes(seat);
      updateText(get(card, 'small'), alive ? decision ? decisionLabels[decision.status] : '等待记录' : '已淘汰');
      updateText(get(card, 'strong'), String(snapshot.scores[seat] ?? 0));
      updateText(get(card, '.territory-count'), `${snapshot.territoryCounts[seat] ?? 0} 块领地`);
      const model = get(card, 'p');
      const label = modelLabel(run.models[index] ?? '', this.models);
      if (model.title !== label) model.title = label;
      updateText(model, label);
    });
  }
  private updateBattleDecisions(run: RunSummary, decisions: DecisionSummary[], outcomes: StateFrame['outcome'], waiting: boolean): void {
    const previous = this.decisionView;
    if (previous?.decisions === decisions && previous.outcome === outcomes && previous.waiting === waiting) return;
    this.decisionView = { decisions, outcome: outcomes, waiting };
    updateText(get(this.root, '#decision-round'), decisions.length ? `第 ${Math.max(...decisions.map(decision => decision.round))} 轮` : '尚无决策');
    this.setBattleContent('#decisions', `${waiting ? '<p class="waiting-note">各方回复封存前，游戏时钟暂停推进。</p>' : ''}${decisions.length ? SEATS.slice(0, run.factionCount).map(seat => {
      const decision = decisions.findLast(item => item.owner === seat);
      return `<article class="decision-item seat-${seat}"><div class="decision-item-title"><strong>${SEAT_LABELS[seat]}</strong><span>${decision ? decisionLabels[decision.status] : '等待记录'}</span></div>${decision ? `<p class="intent">${h(decision.intent || (decision.status === 'waiting' ? '等待模型返回本轮意图。' : '本轮未提供战术说明。'))}</p>${decision.error ? `<p class="inline-error">${h(decision.error)}</p>` : ''}${decision.receipts?.length ? `<details class="receipts"><summary>${this.screen === 'replay' ? '执行摘要' : '执行回执'} / ${decision.receipts.length} 条</summary><pre>${h(pretty(decision.receipts))}</pre></details>` : '<p class="receipt-empty">尚无执行回执</p>'}<div class="decision-meta">${decision.latencyMs === undefined ? '' : `耗时 ${(decision.latencyMs / 1000).toFixed(2)}s`}${decision.costUsd === undefined ? '' : ` / ${formatUsd(decision.costUsd)}`}</div>` : '<p class="receipt-empty">服务端尚未记录该阵营决策。</p>'}</article>`;
    }).join('') : emptyState('尚无模型决策', '首轮观察与模型回复保存后显示。')}${outcomes ? `<div class="outcome"><h3>终局裁决</h3><p>${h(outcomes.reason)}</p>${outcomes.standings.map(standing => `<p><strong>第 ${standing.rank} 名</strong> ${SEAT_LABELS[standing.owner]} / ${standing.score} 分 / ${standing.troops} 兵</p>`).join('')}</div>` : ''}<p class="panel-footnote">战术说明是模型自述；行动效果以引擎回执为准。</p>`);
  }
  private watchTimelineShell(): string {
    return `<div class="timeline-top"><div class="timeline-title"><h2>事件时间线</h2><span id="watch-events-count" class="meta"></span></div><div class="playback-controls"><button class="text-button" data-action="open-run" data-run="${h(this.runId)}" data-target="replay">逐轮回放${icon('arrow')}</button></div></div>
      <div class="timeline-range"><span id="watch-position" class="numeric">00:00</span><input type="range" name="seek" min="0" max="0" step="1" value="0" aria-label="跳转到已记录游戏时间" aria-valuetext="00:00" disabled><span id="watch-duration" class="numeric">00:00</span></div>
      <div id="watch-events" class="event-strip"></div>`;
  }
  private updateWatchTimeline(frame: StateFrame, tick: number): void {
    const maximum = Math.max(this.detail?.run.tick ?? 0, frame.snapshot.tick);
    const time = formatClock(tick);
    updateText(get(this.root, '#watch-position'), time);
    updateText(get(this.root, '#watch-duration'), formatClock(maximum));
    const slider = get<HTMLInputElement>(this.root, '#timeline [name="seek"]');
    if (slider.max !== String(maximum)) slider.max = String(maximum);
    if (slider.value !== String(tick)) slider.value = String(tick);
    if (slider.getAttribute('aria-valuetext') !== time) slider.setAttribute('aria-valuetext', time);
    const privateMessages = this.detail?.spectatorAccess?.privateMessages === true;
    if (this.watchEvents?.source !== frame.events || this.watchEvents.privateMessages !== privateMessages) {
      this.watchEvents = { source: frame.events, privateMessages, visible: visibleEvents(frame.events, this.detail?.spectatorAccess) };
    }
    const events = this.watchEvents;
    const end = events.visible.findLastIndex(event => event.tick <= tick) + 1;
    const selection = events.visible[end - 1]?.tick === tick ? tick : undefined;
    if (events.end === end && events.selection === selection) return;
    events.end = end;
    events.selection = selection;
    updateText(get(this.root, '#watch-events-count'), `${end} 条已记录事件`);
    this.setBattleContent('#watch-events', this.eventChips(events.visible.slice(0, end), tick));
  }
  private renderReplayTimeline(detail: RunDetail): void {
    const maximum = detail.run.tick;
    const events = visibleEvents(detail.events, detail.spectatorAccess);
    setContent(this.root, '#timeline', `<div class="timeline-top"><div class="timeline-title"><h2>事件时间线</h2><span class="meta">${events.length} 条已记录事件</span></div><div class="playback-controls"><span id="replay-buffer" class="meta" role="status" hidden></span><button class="button small" data-action="toggle-play" disabled>${icon('play')}播放回放</button><label class="speed-label"><span class="sr-only">播放倍速</span><select name="speed" aria-label="播放倍速">${[0.5, 1, 2, 4, 8].map(speed => `<option value="${speed}" ${this.speed === speed ? 'selected' : ''}>${speed}×</option>`).join('')}</select></label></div></div>
      <div class="timeline-range"><span id="replay-position" class="numeric">${formatClock(maximum)}</span><input type="range" name="seek" min="0" max="${maximum}" step="1" value="${maximum}" aria-label="跳转到已记录游戏时间" aria-valuetext="${formatClock(maximum)}" ${maximum === 0 ? 'disabled' : ''}><span class="numeric">${formatClock(maximum)}</span></div>
      <div class="event-strip">${this.eventChips(events)}</div>`);
  }
  private eventChips(events: RunEvent[], current?: number): string {
    const keys = events.filter(event => !['cannon', 'overflow', 'front', 'defend'].includes(event.type)).slice(-80);
    return keys.length ? keys.map(event => `<button class="event-chip ${event.tick === current ? 'selected' : ''}" data-action="event" data-tick="${event.tick}" title="${h(event.detail ?? eventTitle(event))}"><span class="event-time">${formatClock(event.tick)}</span><span>${h(eventTitle(event))}</span></button>`).join('') : '<p class="field-note">尚无关键事件。事件发生后可从这里跳转。</p>';
  }
  private updateReplayTimeline(): void {
    const replay = this.replay;
    if (!replay) return;
    const current = replay.tick;
    const selected = this.replaySeekDraft ?? (replay.buffering && !replay.playing ? replay.seekTick : null) ?? current ?? replay.seekTick ?? replay.maximum;
    const slider = get<HTMLInputElement>(this.root, 'input[name="seek"]');
    if (slider.valueAsNumber !== selected) slider.valueAsNumber = selected;
    const clock = formatClock(selected);
    const position = get(this.root, '#replay-position');
    if (position.textContent !== clock) {
      position.textContent = clock;
      slider.setAttribute('aria-valuetext', clock);
    }
    const play = get<HTMLButtonElement>(this.root, '[data-action="toggle-play"]');
    play.disabled = replay.maximum === 0 || current === null || this.replaySeekDraft !== null || replay.buffering && !replay.playing;
    const playing = String(replay.playing);
    if (play.dataset.playing !== playing) {
      play.dataset.playing = playing;
      play.innerHTML = replay.playing ? `${icon('pause')}暂停回放` : `${icon('play')}播放回放`;
    }
    const buffer = get(this.root, '#replay-buffer');
    const message = replay.buffering ? replay.playing ? '正在缓冲回放…' : '正在读取画面…' : '';
    if (buffer.textContent !== message) { buffer.textContent = message; buffer.hidden = !message; }
    if (this.replayMarkedTick !== current) {
      get(this.root, '#timeline').querySelectorAll(`.event-chip[data-tick="${this.replayMarkedTick}"]`).forEach(chip => chip.classList.remove('selected'));
      get(this.root, '#timeline').querySelectorAll(`.event-chip[data-tick="${current}"]`).forEach(chip => chip.classList.add('selected'));
      this.replayMarkedTick = current;
    }
  }
  private async seek(tick: number): Promise<void> {
    if (!this.runId || !this.detail) return;
    if (this.screen === 'replay') {
      this.replaySeekDraft = null;
      this.replay?.seek(recordedTick(tick, this.detail.run.tick));
      return;
    }
    const sequence = ++this.sequence;
    this.loadingFrame = true;
    try {
      const requested = recordedTick(tick, this.detail.run.tick);
      const frame = await api.state(this.runId, requested);
      if (sequence !== this.sequence) return;
      this.acceptFrame(frame, true);
      this.pageError = '';
      this.showNotice();
    } catch (error) {
      if (sequence === this.sequence) { this.pageError = errorMessage(error); this.showNotice(); }
    } finally { if (sequence === this.sequence) this.loadingFrame = false; }
  }
  private cancelRoundRequest(): void {
    this.roundRequest?.controller.abort();
    this.roundRequest = null;
  }
  private showRoundMessage(html: string): void {
    if (this.roundMessage === html) return;
    this.roundMessage = html;
    setContent(this.root, '#round-inspector', html);
  }
  private loadRoundForFrame(): void {
    const replay = this.replay;
    if (!replay || !this.detail) return;
    const round = this.frame?.decisions[0]?.round;
    if (!replay.playing && !replay.buffering && this.replaySeekDraft === null && round !== undefined) {
      if (this.round?.round === round || this.roundRequest?.index === round) return;
      this.cancelRoundRequest();
      this.round = this.replayRounds.get(round) ?? null;
      if (this.round) { this.updateInspector(); return; }
      const request = { controller: new AbortController(), index: round };
      this.roundRequest = request;
      this.showRoundMessage('<div class="inspector-loading" role="status">正在读取本轮观察与真实输出…</div>');
      void api.round(this.runId, round, request.controller.signal).then(detail => {
        if (this.roundRequest !== request) return;
        this.roundRequest = null;
        if (this.replayRounds.size >= 3) this.replayRounds.delete(this.replayRounds.keys().next().value!);
        this.replayRounds.set(detail.round, detail);
        this.round = detail;
        this.updateInspector();
      }).catch(error => {
        if (this.roundRequest !== request) return;
        this.roundRequest = null;
        this.showRoundMessage(`<p class="inline-error" role="alert">本轮记录读取失败：${h(errorMessage(error))}</p>`);
      });
      return;
    }
    this.cancelRoundRequest();
    this.round = null;
    if (replay.playing) this.showRoundMessage(emptyState('正在播放回放', '暂停后可查看当前轮次的原始观察和模型输出。'));
    else if (replay.buffering || this.replaySeekDraft !== null) this.showRoundMessage('<div class="inspector-loading" role="status">正在定位轮次…</div>');
    else this.showRoundMessage(emptyState('这一刻尚无决策轮', '向后移动时间线，查看已保存的模型观察与实际输出。'));
  }
  private updateInspector(): void {
    if (!this.round) return;
    this.roundMessage = '';
    const round = this.round;
    const decision = round.decisions.find(item => item.owner === this.activeSeat);
    const messages = visibleEvents(decision?.messages ?? [], round.spectatorAccess);
    setContent(this.root, '#round-inspector', `<div class="section-heading"><div><h2>第 ${round.round} 轮原始记录</h2><p>游戏时间 ${formatClock(round.tick)} / 服务端保存的实际请求与返回</p></div><label class="field inline-field">查看阵营<select name="inspect-seat">${SEATS.slice(0, this.frame?.run.factionCount ?? 4).map(seat => `<option value="${seat}" ${seat === this.activeSeat ? 'selected' : ''}>${SEAT_LABELS[seat]}</option>`).join('')}</select></label></div>
      <p class="privacy-note"><strong>观众私聊权限：${round.spectatorAccess.privateMessages ? '已授权查看' : '不可查看'}</strong> ${h(round.spectatorAccess.note)} 观察和原始输出按服务端观众权限提供。</p>
      ${decision ? `<div class="record-grid"><details class="record-panel" open><summary>本轮观察</summary><pre>${h(pretty(decision.observation))}</pre></details><details class="record-panel" open><summary>模型真实输出</summary><pre>${h(pretty(decision.output))}</pre></details><details class="record-panel"><summary>引擎执行回执</summary><pre>${h(pretty(decision.receipts))}</pre></details><details class="record-panel"><summary>已授权消息 / ${messages.length} 条</summary>${messages.length ? messages.map(message => `<p><strong>${h(eventTitle(message))}</strong><br>${h(message.detail)}</p>`).join('') : '<p>本轮没有可供观众查看的消息。</p>'}</details></div>` : emptyState('该阵营没有本轮记录', '它可能已被淘汰，或本轮尚未保存。')}`);
  }
  private studioShell(): string {
    return `<div class="studio-toolbar"><p>剪辑引用已记录事件，比赛日志保持原样。</p><div class="toolbar-actions"><span id="save-state" class="meta">正在读取脚本…</span><button class="button small" data-action="save-storyboard">${icon('check')}保存脚本</button><button class="button primary small" data-action="export-video">${icon('film')}导出成片</button></div></div>
      <div class="studio-layout"><section class="story-catalog"><div class="panel-heading"><h2>节目片段</h2><span id="story-duration" class="meta"></span></div><div id="story-segments">${emptyState('读取真实事件脚本', '脚本由服务端依据本场对局生成。')}</div><details class="source-events"><summary>从真实事件添加片段</summary><div id="story-events"></div></details></section>
      <section class="studio-preview"><div class="map-title"><h2>战局预览</h2><a class="text-button" href="/broadcast?run=${encodeURIComponent(this.runId)}" target="_blank" rel="noopener">清洁导播画面${icon('expand')}</a></div><div class="map-stage studio-map" data-full-bleed><canvas id="battlefield" class="map-canvas" hidden aria-label="节目片段的真实战局"></canvas><div id="map-empty" class="map-empty">${icon('film')}<p>等待读取战局快照…</p></div></div><div id="story-preview-caption" class="story-preview-caption"></div><div class="audio-panel"><div class="section-heading"><div><h2>旁白音轨</h2><p>试听服务端实际生成的音轨。</p></div><button class="button small" data-action="prepare-audio">生成试听</button></div><div id="audio-preview"><p class="field-note">保存旁白后生成音轨。需要服务端可用的语音服务或系统语音。</p></div><div class="audio-import"><label class="field">导入已对齐的完整配音<input name="audio-file" type="file" accept="audio/wav,audio/x-wav,audio/mpeg,.wav,.mp3"></label><button class="button small" data-action="upload-audio">导入音轨</button><button class="text-button" data-action="system-audio">使用配置的旁白</button><span id="audio-source" class="field-note">当前：配置的旁白</span></div></div></section>
      <section id="segment-editor" class="segment-editor" aria-label="编辑片段旁白">${emptyState('选择一个片段', '编辑旁白与字幕，或从真实事件添加。')}</section></div>
      <section class="export-panel" aria-labelledby="export-title"><div class="section-heading"><div><h2 id="export-title">导出任务</h2><p>1920 × 1080 / 30 fps / 真实引擎画面</p></div></div><div id="export-job">${emptyState('还没有导出任务', '保存节目脚本，再导出带旁白与字幕的成片。')}</div></section>`;
  }
  private updateStudio(): void {
    if (!this.board || !this.detail) return;
    const board = this.board;
    setContent(this.root, '#save-state', this.dirty ? '脚本有未保存修改' : '脚本已载入');
    setContent(this.root, '#story-duration', `${board.segments.length} 段 / ${board.durationSeconds.toFixed(1)}s`);
    setContent(this.root, '#story-segments', board.segments.length ? board.segments.map((segment, index) => `<button class="story-segment ${segment.id === this.selectedSegment ? 'selected' : ''}" data-action="select-segment" data-segment="${h(segment.id)}"><span class="segment-number">${(index + 1).toString().padStart(2, '0')}</span><span><strong>${h(segment.caption || (segment.kind === 'opening' ? '开场' : segment.kind === 'result' ? '终局' : segment.kind === 'replay' ? '整局录像' : '事件片段'))}</strong><small>${formatClock(segment.gameStartTick)} - ${formatClock(segment.gameEndTick)} / ${segment.durationSeconds.toFixed(1)}s</small></span>${icon('arrow')}</button>`).join('') : emptyState('脚本还没有片段', '从下方已记录事件添加节目片段。'));
    const events = visibleEvents(this.detail.events, this.detail.spectatorAccess).filter(event => event.visibility !== 'private');
    setContent(this.root, '#story-events', events.length ? events.map(event => `<button class="source-event" data-action="add-event" data-event="${h(event.id)}"><span class="numeric">${formatClock(event.tick)}</span><span>${h(eventTitle(event))}</span>${icon('plus')}</button>`).join('') : '<p class="field-note">本场没有可引用的公开事件。</p>');
    this.updateSegmentEditor();
    this.updateExport();
  }
  private updateSegmentEditor(): void {
    const segment = this.board?.segments.find(item => item.id === this.selectedSegment);
    if (!segment) { setContent(this.root, '#segment-editor', emptyState('选择一个片段', '从节目片段中选择，或添加已记录事件。')); return; }
    const eventIds = segment.eventIds;
    const sources = this.detail?.events.filter(event => eventIds.includes(event.id)) ?? [];
    setContent(this.root, '#segment-editor', `<div class="panel-heading"><h2>旁白与字幕</h2><span class="meta">${segment.kind === 'opening' ? '开场' : segment.kind === 'result' ? '终局' : segment.kind === 'replay' ? '整局录像' : '真实事件'}</span></div><p class="segment-time">${formatClock(segment.gameStartTick)} - ${formatClock(segment.gameEndTick)}<br><span>片长 ${segment.durationSeconds.toFixed(1)}s / ${segment.playbackRate}×</span></p><label class="field">画面字幕<textarea name="segment-caption" rows="3" maxlength="1200">${h(segment.caption)}</textarea></label><label class="field">解说旁白<textarea name="segment-narration" rows="9" maxlength="6000">${h(segment.narration)}</textarea></label><p class="field-note">用事件与实际回执描述结果。模型意图请标明“模型自述”。</p><div class="source-reference"><h3>引用事实</h3>${sources.length ? sources.map(event => `<p><strong>${h(eventTitle(event))}</strong><br>${h(event.detail ?? `记录时刻 ${formatClock(event.tick)}`)}</p>`).join('') : '<p>开场或终局片段，引用本场比赛记录。</p>'}</div>${segment.kind === 'event' ? `<button class="text-button danger" data-action="remove-segment" data-segment="${h(segment.id)}">${icon('close')}移除此片段</button>` : '<p class="field-note">开场与终局保留，确保节目包含比赛起止状态。</p>'}`);
    setContent(this.root, '#story-preview-caption', h(segment.caption));
  }
  private retimeBoard(): void {
    if (!this.board) return;
    let seconds = 0;
    for (const segment of this.board.segments) { segment.videoStartSeconds = seconds; seconds += segment.durationSeconds; }
    this.board.durationSeconds = seconds;
    this.dirty = true;
    this.audioUrl = '';
    this.importedAssetId = '';
    setContent(this.root, '#audio-source', '当前：配置的旁白。片段时序已修改，请重新生成或导入配音。');
    setContent(this.root, '#audio-preview', '<p class="field-note">脚本已修改，请重新生成试听音轨。</p>');
  }
  private async saveBoard(): Promise<boolean> {
    if (!this.board) throw new Error('节目脚本尚未载入。');
    const runId = this.runId;
    const submitted = JSON.stringify(this.board);
    const result = await api.saveStoryboard(runId, this.board);
    if (runId !== this.runId || this.screen !== 'studio') return false;
    if (JSON.stringify(this.board) === submitted) { this.board = result; this.dirty = false; }
    setContent(this.root, '#save-state', this.dirty ? '仍有未保存修改' : '脚本已保存');
    return true;
  }
  private async prepareAudio(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const runId = this.runId;
    this.studioBusy(true);
    setContent(this.root, '#audio-preview', '<p role="status">正在保存脚本并生成真实音轨…</p>');
    try {
      if (!await this.saveBoard()) return;
      const result = await api.narration(runId);
      if (runId !== this.runId || this.screen !== 'studio') return;
      const url = artifactUrl(result.audioUrl);
      if (!url) throw new Error('服务器未返回有效的音轨下载地址。');
      this.audioUrl = url;
      if (result.storyboard) { this.board = result.storyboard; this.updateStudio(); }
      setContent(this.root, '#audio-preview', `<audio controls preload="metadata" src="${h(url)}" aria-label="实际生成的旁白音轨"></audio><a class="text-button" href="${h(url)}" download>下载音轨${icon('download')}</a>`);
      this.pageError = '';
    } catch (error) {
      if (runId === this.runId) {
        const message = errorMessage(error);
        setContent(this.root, '#audio-preview', `<p class="inline-error" role="alert">音轨尚未生成：${h(message)}</p>`);
      }
    } finally { this.busy = false; this.studioBusy(false); this.showNotice(); }
  }
  private async uploadAudio(): Promise<void> {
    if (this.busy) return;
    const file = this.root.querySelector<HTMLInputElement>('[name="audio-file"]')?.files?.[0];
    if (!file) throw new Error('请先选择 WAV 或 MP3 配音文件。');
    this.busy = true;
    this.studioBusy(true);
    const runId = this.runId;
    try {
      const result = await api.uploadAudio(runId, file);
      if (runId !== this.runId || this.screen !== 'studio') return;
      const url = artifactUrl(result.audioUrl);
      if (!url) throw new Error('服务器未返回有效的导入音轨地址。');
      this.importedAssetId = result.assetId;
      this.audioUrl = url;
      setContent(this.root, '#audio-source', `当前：导入音轨 ${h(file.name)}`);
      setContent(this.root, '#audio-preview', `<audio controls preload="metadata" src="${h(url)}" aria-label="已导入的配音音轨"></audio><p class="field-note">导出使用这条完整音轨。请确认配音已与节目时间对齐。</p>`);
    } finally { this.busy = false; this.studioBusy(false); }
  }
  private studioBusy(busy: boolean): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="save-storyboard"], [data-action="prepare-audio"], [data-action="export-video"], [data-action="upload-audio"]').forEach(button => { button.disabled = busy; });
  }
  private async exportVideo(): Promise<void> {
    if (this.busy) return;
    if (!this.board?.segments.length) throw new Error('请先选择真实事件片段。');
    this.busy = true;
    this.studioBusy(true);
    const runId = this.runId;
    try {
      if (!await this.saveBoard()) return;
      const { jobId } = await api.export(runId, { format: 'mp4', width: 1920, height: 1080, fps: 30, narration: this.importedAssetId ? { provider: 'import', assetId: this.importedAssetId } : undefined });
      if (runId !== this.runId || this.screen !== 'studio') return;
      this.job = await api.job(jobId);
      this.updateExport();
      clearInterval(this.jobPoll);
      let polling = false;
      this.jobPoll = window.setInterval(() => {
        if (polling) return;
        polling = true;
        void api.job(jobId).then(job => {
          if (runId !== this.runId || this.screen !== 'studio') return;
          this.job = job;
          this.updateExport();
          if (['completed', 'failed'].includes(job.status)) clearInterval(this.jobPoll);
        }).catch(error => {
          clearInterval(this.jobPoll);
          this.pageError = `导出进度读取失败：${errorMessage(error)}`;
          this.showNotice();
        }).finally(() => { polling = false; });
      }, 1200);
      this.pageError = '';
    } finally { this.busy = false; this.studioBusy(false); }
  }
  private updateExport(): void {
    const job = this.job;
    if (!job) return;
    const progress = Math.max(0, Math.min(1, job.progress));
    const artifacts = (job.artifacts ?? []).filter(artifact => artifactUrl(artifact.url));
    setContent(this.root, '#export-job', `<div class="job-status"><div><strong>${job.status === 'completed' ? '成片已完成' : job.status === 'failed' ? '导出失败' : job.status === 'queued' ? '等待导出' : '正在导出'}</strong><span class="meta">${h(job.stage ?? '')} / ${h(job.id)}</span></div><span class="numeric">${Math.round(progress * 100)}%</span></div><progress max="1" value="${progress}" aria-label="导出进度">${Math.round(progress * 100)}%</progress>${job.error ? `<p class="inline-error" role="alert">${h(job.error)}</p>` : ''}<div class="artifact-links">${artifacts.map(artifact => `<a class="button small" href="${h(artifactUrl(artifact.url)!)}" download>${icon('download')}${h(artifact.name)}</a>`).join('')}</div>`);
  }
  private async onClick(event: MouseEvent): Promise<void> {
    const target = (event.target as Element).closest<HTMLElement>('[data-action], [data-screen]');
    if (!target) return;
    event.preventDefault();
    if (target instanceof HTMLButtonElement && target.disabled) return;
    try {
      if (target.dataset.screen) { this.navigate(target.dataset.screen as Screen); return; }
      const action = target.dataset.action;
      if (action === 'open-run') this.navigate(target.dataset.target as Screen, target.dataset.run!);
      else if (action === 'open-model-dialog') get<HTMLDialogElement>(this.root, '#model-dialog').showModal();
      else if (action === 'close-model-dialog') get<HTMLDialogElement>(this.root, '#model-dialog').close();
      else if (action === 'start-recording' || action === 'reload-recording') {
        await this.loadRecording(action === 'start-recording', true);
        return;
      }
      else if (action === 'quote-start-budget') {
        await this.quoteStartBudget();
        return;
      }
      else if (action === 'rebuild-budget') this.rebuildWithBudget();
      else if (action === 'refresh-lists') {
        const sequence = this.sequence;
        this.readConfig();
        await this.refreshLists();
        if (this.screen === 'build' && sequence === this.sequence) {
          this.readConfig();
          this.resetStartBudget();
          this.renderBuild();
        }
      }
      else if (action === 'retry') {
        if (this.screen === 'build') {
          const sequence = this.sequence;
          await this.refreshLists();
          if (sequence !== this.sequence) return;
          this.readConfig();
          this.resetStartBudget();
          this.renderBuild();
          this.pageError = '';
        } else await this.loadRunScreen();
      }
      else if (action === 'toggle-tournament') {
        if (!this.tournamentDetail) return;
        if (this.tournamentDetail.status === 'paused') await api.resumeTournament(this.tournamentId); else await api.pauseTournament(this.tournamentId);
        await this.loadTournamentDetail();
      }
      else if (action === 'new-seed') {
        this.readConfig();
        this.config.seed = newSeed();
        get<HTMLInputElement>(this.root, '[name="seed"]').value = String(this.config.seed);
        this.buildFieldEdited('seed');
      }
      else if (action === 'zoom-in') this.battlefield?.zoom(1.2);
      else if (action === 'zoom-out') this.battlefield?.zoom(1 / 1.2);
      else if (action === 'reset-camera') this.battlefield?.resetCamera();
      else if (action === 'toggle-pause') await this.togglePause();
      else if (action === 'toggle-play') { if (this.replay?.playing) this.replay.pause(); else this.replay?.play(); }
      else if (action === 'event') {
        const tick = Number(target.dataset.tick);
        if (this.screen === 'watch') { this.pendingSeek = { runId: this.runId, tick }; this.navigate('replay'); }
        else await this.seek(tick);
      }
      else if (action === 'select-segment') {
        this.selectedSegment = target.dataset.segment!;
        this.updateStudio();
        const segment = this.board?.segments.find(item => item.id === this.selectedSegment);
        if (segment) await this.seek(segment.gameStartTick);
      }
      else if (action === 'add-event') {
        const source = this.detail?.events.find(item => item.id === target.dataset.event && item.visibility !== 'private');
        if (!source || !this.board || !this.detail) return;
        const result = addStoryEvent(this.board, source, `event-${crypto.randomUUID()}`);
        this.board = result.board;
        this.selectedSegment = result.segmentId;
        this.retimeBoard();
        this.updateStudio();
        await this.seek(source.tick);
      }
      else if (action === 'remove-segment') {
        if (!this.board) return;
        this.board.segments = this.board.segments.filter(item => item.id !== target.dataset.segment || item.kind !== 'event');
        this.selectedSegment = this.board.segments[0]?.id ?? '';
        this.retimeBoard(); this.updateStudio();
      }
      else if (action === 'save-storyboard') { if (await this.saveBoard()) this.notice = '节目脚本已保存。'; }
      else if (action === 'upload-audio') await this.uploadAudio();
      else if (action === 'system-audio') {
        this.importedAssetId = ''; this.audioUrl = '';
        setContent(this.root, '#audio-source', '当前：配置的旁白');
        setContent(this.root, '#audio-preview', '<p class="field-note">已切回配置的旁白，点击“生成试听”生成真实音轨。</p>');
      }
      else if (action === 'prepare-audio') { this.importedAssetId = ''; setContent(this.root, '#audio-source', '当前：配置的旁白'); await this.prepareAudio(); }
      else if (action === 'export-video') await this.exportVideo();
      this.showNotice();
    } catch (error) { this.pageError = errorMessage(error); this.showNotice(); }
  }
  private rebuildWithBudget(): void {
    const run = this.frame?.run;
    if (this.screen !== 'watch' || !run) return;
    const field = startBudgetStopField(run, this.resumeStartBudget);
    if (!field) return;
    const { track, seed, durationSeconds, factionCount, models, disaster, budget, recordVideo } = run;
    this.config = {
      track, seed, durationSeconds, factionCount, models: [...models], disaster,
      budget: { maxCalls: budget.maxCalls, maxCostUsd: budget.maxCostUsd }, recordVideo,
    };
    this.navigate('build', run.id);
    get<HTMLInputElement>(this.root, `[name="${field}"]`).focus();
    void this.quoteStartBudget();
  }
  private async togglePause(): Promise<void> {
    if (!this.frame || this.busy || startBudgetStopField(this.frame.run, this.resumeStartBudget)) return;
    this.busy = true;
    this.updateBattle();
    const sequence = this.sequence;
    const runId = this.runId;
    try {
      const { run } = this.frame.run.status === 'paused' ? await api.resume(runId) : await api.pause(runId);
      if (sequence !== this.sequence || !this.frame) return;
      this.frame.run = run;
      this.notice = run.status === 'paused' ? '比赛已暂停。' : '比赛已恢复。';
      this.pageError = '';
    } catch (error) {
      if (sequence !== this.sequence) return;
      if (!(error instanceof ApiError) || error.code !== 'START_BUDGET_TOO_LOW' || !error.startBudget) throw error;
      this.resumeStartBudget = error.startBudget;
      this.pageError = '';
      this.notice = '';
    } finally {
      this.busy = false;
      if (this.screen === 'watch') this.updateBattle();
    }
  }
  private async onChange(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    try {
      if (target.name === 'tournament-picker') {
        this.tournamentId = target.value; this.tournamentDetail = null;
        if (target.value) await this.loadTournamentDetail();
        else setContent(this.root, '#tournament-report', emptyState('选择已保存批次', '统计仅取自该批次的真实比赛。'));
      }
      else if (target.name === 'run-picker') this.navigate(this.screen, target.value);
      else if (target.name === 'speed') { this.speed = Number(target.value); this.replay?.setSpeed(this.speed); }
      else if (target.name === 'seek') await this.seek(Number(target.value));
      else if (target.name === 'inspect-seat') { this.activeSeat = target.value as Seat; this.updateInspector(); }
      else if (this.screen === 'build' && target.form?.id === 'build-form') {
        this.buildFieldEdited(target.name);
        const previous = this.config.models;
        this.readConfig();
        if (target.name === 'track' && this.config.track === 'diplomacy' && this.config.factionCount === 2) this.config.factionCount = 3;
        const defaults = defaultModels(this.models, this.config.factionCount);
        this.config.models = Array.from({ length: this.config.factionCount }, (_, index) => this.config.models[index] || previous[index] || defaults[index] || '');
        if (['track', 'factionCount'].includes(target.name) || target.name.startsWith('model-')) this.renderBuild();
        else if (target.name === 'durationSeconds') setContent(this.root, '#budget-estimate', this.budgetEstimate());
      }
    } catch (error) { this.pageError = errorMessage(error); this.showNotice(); }
  }
  private onInput(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (target.name === 'seek' && this.replay) {
      this.replaySeekDraft = Number(target.value);
      this.replay.pause();
      this.replay.cancelSeek();
      this.updateReplayTimeline();
      this.loadRoundForFrame();
      return;
    }
    if (this.screen === 'build' && target.form?.id === 'build-form') {
      this.buildFieldEdited(target.name);
      return;
    }
    if (!['segment-caption', 'segment-narration'].includes(target.name)) return;
    const segment = this.board?.segments.find(item => item.id === this.selectedSegment);
    if (!segment) return;
    if (target.name === 'segment-caption') { segment.caption = target.value; setContent(this.root, '#story-preview-caption', h(target.value)); }
    else segment.narration = target.value;
    this.dirty = true;
    this.audioUrl = '';
    setContent(this.root, '#save-state', '脚本有未保存修改');
    if (this.importedAssetId) setContent(this.root, '#audio-source', '当前：导入的完整配音。文字修改不会改变该音轨。');
    else setContent(this.root, '#audio-preview', '<p class="field-note">脚本已修改，请重新生成试听音轨。</p>');
  }
}

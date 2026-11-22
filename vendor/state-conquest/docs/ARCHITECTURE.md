# 寸土必争 — 架构说明

> 快照：2026-10-24，v1.0.0 `feat/v1.0.0`（上一发布基线 v0.4.0；main 344689c 是用户已验收的 v0.3）。v1.0 在 v0.4 真实州界/任意己方 source 规则之上加入叛变技能、天灾事件、指挥官档案与金币、异步挑战赛、同屏双人对战与 AI 策略优化。平台/真机未验证项仍为 NOT_RUN。

## 1. 分层

```text
Pointer / Touch
      │  GestureController + hit-test
      ▼
GameAdapter (src/ui/game-adapter.ts)
      │  issueMove / upgrade(kind) / evaluateUpgrade / tick / snapshot
      ▼
game-api (src/game-api.ts)  ← 唯一 UI 可依赖的公开契约
      │
      ├── MatchEngine (core/engine.ts) — 唯一 tick 时钟，solo / challenge / versus
      │     ├── AI planner (ai/planner.ts；versus 不运行)
      │     ├── betrayal skill (core/skills.ts) / disaster (core/disaster.ts)
      │     ├── cannon (core/cannon.ts + army-route.ts)
      │     ├── arrivals / combat (core/movement.ts, combat.ts)
      │     ├── production (core/production.ts)
      │     └── score / end conditions (core/score.ts)
      │
      └── MatchSnapshot（深拷贝只读数据）
              ├── CanvasRenderer（src/rendering + effects.ts）
              ├── DOM HUD / screens（src/ui）
              └── Result screen

Archive / challenge（局外，局部状态，不进 MatchState）
      ├── ProfileStore（ui/profile-store.ts）— 昵称/头像/金币/叛变等级/战绩
      ├── Challenge codec（core/challenge.ts）— seed+时长+难度+分数 编解码
      └── Home / Profile / Upgrade / Challenge screens

PlatformAdapter（src/platform）— 与游戏内核完全隔离
      ├── storage（9.46+，localStorage/内存降级）
      ├── layout（getWindowInfo 9.49+ / CSS env）
      ├── vibration（9.50+ 官方 API）
      ├── lifecycle（visibilitychange）
      └── share（海报 Canvas；仅用户点击；无 SDK 时禁用）
```

**硬边界**：渲染与 UI 不直接修改 `MatchState`；AI 不直接改兵力；平台层不引用 core/UI。炮击只由 core 产生事件，渲染只消费。

## 2. 模块与文件

| 区域 | 文件 | 职责 |
|---|---|---|
| 公开 API | `src/game-api.ts` | `createMatch`、`evaluateMove`、`evaluateUpgrade`、`MatchSession`、类型再导出；UI 只从这里取核心能力 |
| 规则内核 | `src/core/engine.ts` | 固定步长 tick、状态机、结束判定；顺序见 §3 |
| 规则内核 | `core/commands.ts` | 玩家/AI 共用 `computeMovePlan/applyMove/computeUpgradePlan/applyUpgrade`，支持 production/march/defense；目标只需与任意己方 territory 有 passable edge |
| 规则内核 | `core/reachability.ts` | per-pass cache 的 `createOwnerReachability`/`planMoveRoute`：owner attack targets、frontier 选择、同己方 BFS 路线、断连 fallback、真实 travelTicks |
| 规则内核 | `core/skills.ts`、`core/disaster.ts` | 叛变目标池/策反战斗/冷却；天灾独立派生 RNG、预警与逐格损兵；均不读 UI |
| 规则内核 | `core/challenge.ts` | 挑战码纯函数编解码（base36 + 校验位）、字段错误分类、分数比较 verdict |
| 规则内核 | `core/cannon.ts`、`army-route.ts` | 射程、每 8 tick 炮击、真实路线扫掠、命中点；渲染/AI/炮击共享折线几何 |
| 规则内核 | `core/combat.ts`、`movement.ts` | 整数战斗、地形防御、护盾先吸收、抵达排序、中立恢复 |
| 规则内核 | `core/dispatch.ts`、`capacity.ts`、`production.ts`、`score.ts` | 15% 留守、面积容量、产兵、存活/限时决胜 |
| 规则内核 | `core/events.ts` | 有界 UI 事件（overflow/capture/upgrade/eliminated/cannon）；升级事件带 `kind`，炮击带 `targetArmyId/from/to` |
| 规则内核 | `core/state.ts`、`rng.ts` | 地图→初始状态、快照；seed 归一化与 PRNG；炮塔范围/冷却字段 |
| 地图库 | `src/maps/index.ts` | 144 张 `atlas_*` 元数据 + 旧 9 显式变体；`resolveMapVariant(mapId?,duration,seed?)`、`getMapForMatch`；seed→具体图；6 张 LRU 懒构建 |
| 地图库 | `src/maps/library-types.ts`、`generated/map-library.ts` | 紧凑目录（id/name/theme/size/states/groups/spawnAxis），不含多边形 |
| 地图构建 | `src/maps/geographic-map/build.ts`、`regions.ts` | 从 generated 州界/共享边构建区域、spawn、容量/分值、山口/桥头与 geography/boundary 元数据 |
| 地图数据 | `src/maps/generated/us-states.ts` | 由 `npm run mapdata` 从 `data/geography/raw` 离线生成（Census 2017 / us-atlas 3.0.1） |
| 地图门禁 | `src/maps/validate-map.ts` | 合法性/连通性/共享边/公平性 gate |
| 数据 | `data/geography/` | raw TopoJSON、SOURCE.json、144 图库 JSON、Census NOTICE 与 us-atlas LICENSE；只进 source 归档，不进 runtime |
| AI | `src/ai/planner.ts` | any-frontier 候选、TopK 前排除已规划 target、hard 双源协同、三线 ROI 升级、真实 pressure 增援；预测含护盾与当前 tick 炮击相位 |
| AI | `src/ai/forecast.ts`、`clone.ts`、`evaluate.ts` | 纯副本短程推演、状态克隆、威胁/前线/守备评估 |
| AI | `src/ai/risk.ts`、`retreat.ts`、`endgame.ts`、`routing-cache.ts` | 前线风险量化、守不住边缘地收缩、终局分值差决策、per-pass 路线缓存；不改变规则、不使用叛变 |
| 局外档案 | `src/ui/profile-store.ts`、`profile-screen.ts`、`avatar.ts` | 本地指挥官档案（昵称/8 预设头像/金币/叛变等级/战绩）、损坏备份与显式失败 |
| 局外经济 | `src/ui/upgrade-screen.ts` | 5 级叛变金币解锁；余额不足/跳级/满级明确拒绝 |
| 挑战赛 UI | `src/ui/challenge-screen.ts` | 输码/解码错误/锁定参数展示；0 分目标由 shell 拒绝 |
| 输入/渲染/UI | `src/input/*`、`src/rendering/*`、`src/ui/*` | 手势（含双人多指）、命中、Canvas + `effects.ts`（叛变/天灾动效）、首页/档案/设置/教学/HUD/暂停/结算 |
| 配置 | `src/config/balance.ts`、`modes.ts` | 所有数值与 AI 参数 |
| 构建/门禁 | `scripts/build.mjs`、`check-dist.mjs` | esbuild IIFE + CSS 内联；官方体积审计 + 静态语义/ES2017/引用审计 |
| 发布 | `scripts/build-release.mjs` | build → validate → zip → 解压复审计 → manifest；输出 `release/state-conquest-v1.0.0-minitool.zip` |
| 源码归档 | `scripts/build-source.mjs` | 144 图库/生成器/raw/license 完整性、0 临时条目、逐字节等于工作区 |
| 测试/基准 | `scripts/smoke-ui.mjs`、`map-geometry.mjs`、`benchmark-ai.mjs` | DOM 装配；seeded 地图/三升级/容量标签；seeded 或 legacy 基准 |
| 图库生成 | `scripts/prepare-map-library.mjs`（`npm run maplibrary`） | 从 48 州共享边离线选 144 张连续、唯一、公平的图库并写审计 |

## 3. 模拟时序（固定 100 ms）

`App.frameStep(now)`：

1. `elapsed = clamp(now - lastFrameTime, 0, 300)`；`accumulator += elapsed`。
2. 每次 `accumulator >= 100` 且步数 < 3，调用 `MatchEngine.tick()`。
3. 超过 3 步仍有积压时直接清零，绝不无限追帧。
4. 渲染使用 `alpha = accumulator / 100` 做插值；渲染不写状态。

`advanceOneTick(state, rngOrOptions)` 内部顺序（唯一时钟）：

1. `tick += 1`
2. `applyDisasterSchedule`：按独立派生 RNG 预定的 tick 置预警 / 结算全场损兵（solo 与 versus 相同）
3. `runAi`（可关闭）：按难度间隔与指令上限，逐 actor 调用 `runAiForOwner`；每批命令经 `applyMove/applyUpgrade` 校验提交；`versus` 传 `aiEnabled: false`，绝不运行 planner
4. `resolveCannons`：城防 Lv2 炮塔检查 `cannonReadyTick`，按真实路线本 tick 扫掠命中敌军
5. `resolveArrivals`：`arrivalTick <= tick` 的军队按 `arrivalTick ASC, armyId ASC` 结算（含护盾/中立恢复）
6. `produceTick`：每块非中立领地一次整数产兵
7. `updateMaxTerritories`，随后提前结束或倒计时结束判定

玩家指令不走 tick 队列：手势松手时立即经 `GameAdapter.issueMove → applyMove` 校验并提交，下一次 tick 生效；叛变同样即时经 `issueBetrayal` 结算（战斗复用 `resolveBattle`，消耗主 RNG）。AI 只在 tick 内行动，二者共用同一校验器。双人模式双方都走 owner-bound 的即时指令入口，不运行 AI。暂停/失焦停止循环并清空 accumulator，恢复不补算后台时间。

## 4. 地图库与种子选择

- 图库由 48 个可玩州（排除 MI/DE/RI 等碎片/复合问题州）的共享边离线生成；每张图 12/18/24 个连续州，同尺寸/主题 16 张，共 144 张，州集合唯一。
- `resolveMapVariant(undefined|'random', duration, seed)` 先 `normalizeSeed`，用本地纯哈希从该时长的 48 张池中选一张；同一 `(seed,duration)` 恒定同一 `atlas_*` id。显式传 `atlas_*` 或旧 9 个 id 仍按原语义解析。
- 构建是懒的：目录只含状态列表/分组/spawn 轴；实际多边形在首次匹配时构建，内存缓存上限 6 张。
- UI 每局只生成一次 seed（dev 构建可用 `__CONQUEST_DEV_SEED__` 固定），不把 seed 选择散落到渲染或手势。
- 山市/河谷分组在各自一侧内连通，仅两处真实共享边可通行；山市/河谷线是战略抽象，不是地形事实。

## 5. 状态与数据

- `MatchState` 是唯一事实源，只在 core 内修改。
- `MatchSnapshot` 是只读视图：领地（含 capacity/production/march/defense/shield/shieldCapacity/cannonRange/cannonReadyTick）、边、在途军队（含 frozen `routePoints`/`arrivalTick`）、分数、统计、`mode`、`skill`（等级/可用 tick/剩余次数）与 `disaster`（预警/已触发）；地图元数据共享不可变引用。
- 渲染缓存：领地路径/标签随 viewport 重建；底部三状态槽位固定高度，只 patch 文本/图标；升级图标 SVG 复用，steady tick 不重建；防御 wall/tower 缓存带 `defenseLevel`，仅等级变化时更新该领地装饰。
- UI 的 `MatchView` 由 `GameAdapter` 映射，不持有可写规则状态；选中态显示驻军/容量。
- 地图为纯数据，构建时打入 bundle，运行时不 fetch；raw/SOURCE/license 不进 runtime。
- 事件队列有界；UI 通过 `drainEvents/peekEvents` 消费，AI 不读。

## 6. 确定性与可复现

- 固定 `FIXED_DT_MS=100`；生产按 0.1 s 计入余数。
- 所有随机来自 `createRng(seed)`；seed 在 UI 每局生成一次，core 归一化后选图。叛变目标抽取消耗对局主 RNG；天灾调度与逐格伤害使用独立 seed 派生 RNG（固定盐），不改变既有主 RNG 序列。
- 抵达排序显式使用 `arrivalTick`、`armyId`；炮击目标按到达 tick/id 稳定选择。
- 相同 seed + 相同指令序列产生相同状态；双人模式同样确定性（同 seed 无输入可复现分数与天灾时刻）；seeded 基准验证同图换边、终局 hash 重跑一致。
- 挑战码只编码 seed/时长/难度/分数，不携带任何隐藏状态；同码同图同规则。
- 自定义 `geometryFingerprint` 覆盖 mapId/territory polygons/edges，不依赖数组顺序。

## 7. 平台适配层

- `createPlatformAdapter()` 同步创建；`ready()` 初始化版本判断。
- 存储仅在 `buildVersion >= 9460` 使用 `setStorage/getStorage`；否则 localStorage，再退会话内存；`persistent` 反映真实介质。
- `getWindowInfo` 严格 `>= 9490`；否则用 CSS `env()` 并写 `--sc-safe-*`。
- 震动仅官方 `vibrateShort/vibrateLong`（`>= 9500`），不调用 `navigator.vibrate`。
- 分享/保存只在用户点击时调用；无 SDK 时 capabilities 为 false，UI 禁用，战报图仍可浏览器预览。
- 平台层不自动发布、不自动保存；平台 API 未改动。

## 8. 构建与发布流水线

```text
src/main.ts
   │ esbuild bundle（IIFE, target es2017+chrome61, sourcemap=false）
   ▼
dist/index.html（CSS 内联）+ dist/assets/app.js（经典外置脚本）
   │ npm run validate → scripts/check-dist.mjs
   │   ├─ 官方 audit_artifact：体积/文本预算
   │   ├─ 自定义：引用/白名单/路径/inline/CSP/禁 API/acorn ES2017/Base64
   │   └─ artifacts/dist-audit.json
   ▼
npm run package → scripts/build-release.mjs
   ├─ npm run build
   ├─ check-dist 必须 PASS（official PASS + es2017Parse PASS）
   ├─ 在 dist 工作目录 zip 内容（根 index.html）
   ├─ ZIP 条目/CRC/白名单/体积审计
   ├─ 解压到 OS 临时目录，重跑 check-dist + 逐文件 SHA-256 比对
   ├─ 原子替换 release/state-conquest-v1.0.0-minitool.zip
   └─ artifacts/release-manifest.json（SHA-256 + 逐文件清单）
```

本轮实际：官方 Python 审计 PASS、acorn ES2017 PASS、离线/白名单/相对路径 PASS、解压重跑 check-dist 与逐文件 SHA-256 PASS；runtime ZIP 体积/SHA-256 见 `TEST_REPORT.md` 与 `artifacts/release-manifest.json`。仅 1 条 CSS_GAP 提示。

source 归档 `release/state-conquest-v1.0.0-source.zip` 由 `node scripts/build-source.mjs` 生成：含 144 图库 JSON/生成 TS/生成器、raw/SOURCE/license、docs/tests；发布前逐条校验 ZIP 内容与工作区字节一致、临时条目为 0。

## 9. 冻结与发布约束

- 旧基线只读：v0.4.0 release-candidate、main 344689c 的 v0.3、geographic v0.2 与本分支之前 seeded v0.3 共八个 ZIP 永不覆盖；v1.0.0 只写 `state-conquest-v1.0.0-*`。
- 地图库 144 张已冻结（specHash 043ad722…），州集合/分组/id 不变；仅显示名称使用通用“平原/山脊/河谷战场 + 州摘要”。
- 基准不调 AI 参数美化胜率；hard 为真实 planner，greedy 为固定基准策略，同 seed 换边同图；正式 108 采用 order-balanced 协议，每对 seat 一局 hard-first、一局 greedy-first。
- 事件只供表现：core 追加 overflow/capture/upgrade/eliminated/cannon，UI 不重算；炮击伤害由 core 决定；叛变/天灾事件只驱动动效。
- 验证：unit 291/291、DOM smoke 329/329（最终源码）、seeded 108 局 order-balanced hard 50/greedy 58/draw 0、完整性 0；runtime 已通过官方/ES2017/解压逐文件审计；精确结果见 `TEST_REPORT.md`。

## 10. v2.0.0 冻结架构与交付口径（2026-11-15）

> 本节定义 v2.0.0 冻结源码的接线边界与交付口径。第 1–9 节保留 v1.x 架构与历史验证口径；v2 的最终测试/产物状态见 `docs/TEST_REPORT.md` §10 与 `docs/PREVIEW_PROGRESS.md` §21。

### 10.1 核心状态与规则门禁

- `MatchState` 继续是外交、僵局、认输、在途军队与结算的唯一事实源；UI 不自行倒计时、判伤害、判进展或判榜单资格。
- 外交只在普通 solo 创建：开局无默认停战；玩家经暂停面板提案，`proposeTruce` 合法性校验（每方最多 1 盟友、存活 ≥3、同对冷却）后由注入 decider 按接收方自身利益接受/拒绝（`src/ai/diplomacy-evaluate.ts`），核心不自决、无公开旁路。接受盟约 600 tick、拒绝冷却 300 tick；`state.diplomacy.truces` 唯一事实源（可选 `lastDecision/lastDecisionTick/lastDecisionReason`）；成立/撕毁 `uses +1`、拒绝 `+0`，`uses>0` 本局 `practice`。挑战（含旧码/练习码）、教学与 versus 在创建/命令/结算三层均关闭外交。引擎每 tick 两段 `maintainDiplomacy`：存活方降至 2 或盟友淘汰时同 tick 自动解盟，解盟即时取消指向前盟友与失去合法路线的借道兵线（`cancelFrontsForEndedTruce`），已在途军队按冻结 route/arrival 走普通抵达结算。
- 僵局由 core 维护 `lastProgressTick`，仅真实占领或真实防守损伤更新；60 秒预警、120 秒自动结算，复用现有 score/territory/garrison+in-flight tie-break。
- `createOwnerReachability` / `planMoveRoute` 是玩家和 AI 共用的唯一验证入口；source 与 frontier 必须在真实己方连通分量内，删除断连直线 fallback。盟约存续时升级为共享通行网络（shared attack range）：盟友领地可作借道节点与攻击前沿（仅中立或共同敌人），兵源 owner-only（盟友驻军不可动用），盟友自身永不可攻击（hostile-target gate）。dispatch 产生的 routePoints、arrivalTick、owner 进入不可变在途记录，版图变化不回溯重算。兵线等待期若真实路径断开则取消等待中的兵线；已经发出的波次仍按冻结 route/arrival 处理。
- 在途军队抵达停战盟友目标时不创建返程军队：只做一次原地退款，优先退回仍属 owner 的 source，否则使用 `territoryOrder` 中首个仍属 owner 的己方领地；按容量接收，overflow 丢弃；无己方领地则移除 army。该退款只发生在原冻结路线抵达时点。

### 10.2 局外状态与显示层

- 本地签到状态以自然日幂等键保存，回拨日期不得重领；XP 12 级上限与 7 日奖励只能由冻结 `src/config` 提供，UI 不复制配置常量。成功写入后由 `activeProgressScreen.sync` 刷新进度，避免 onWrite 早退留下永久 pending。
- 每局为玩家/阵营建立独立 palette；palette 只进入渲染与可访问名称映射，不进入 core 的攻击、容量、评分或榜单资格。Canvas aria 从当前 owner 状态派生，不硬编码为蓝色。
- 关注入口是显式用户动作，平台返回成功不触发奖励；认输从结果 gate 进入负局路径，并阻断榜单写入与可比较挑战码生成。
- package/challenge/leaderboard/rules 版本边界固定为 `2.0.0` / `2` / `3` / `2`；旧挑战码与旧榜记录走兼容读取后保持练习/历史隔离，不污染新 fixed 组。

### 10.3 平台适配与归档

- 小工具仍按离线 H5 交付：只读在线文档确认公开契约，不主动添加本版未使用的 Worker、平台 API 或网络。在线页面标为内测/加白的能力不进入 v2.0.0 依赖图。
- 平台 adapter 只暴露已有业务所需能力，所有新增能力仍需方法存在性检测与版本降级；在线文档核对不升级为平台验收。
- `build-source.mjs` 沿用自动遍历工作区的 source 归档策略，不新增逐文件登记表；源码归档已真实 PASS：路径为 `release/v2.0.0/state-conquest-v2.0.0-source.zip`，共 221 files，逐文件与工作区一致，runtime manifest 已同步 `sourceArchive` 且 `sourceArchiveVerified=true`；生成结果、大小、SHA 与逐文件校验以外置 `artifacts/v2.0.0/source-manifest.json` 为权威，文档不嵌 source SHA；v1.x release、manifest、ZIP 与历史数字保持只读隔离。

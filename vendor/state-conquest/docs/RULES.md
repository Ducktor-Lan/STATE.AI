# 寸土必争 — 规则与数值（当前实现）

> 快照：2026-11-15，`feat/v2.0.0`，package **2.0.0**，挑战码/本机榜规则版本 **2**。v2.0.0 基线已冻结并备份（`artifacts/v2.0.0/iterations/00-baseline`，含旧「默认全场停战」口径）；当前工作区为三轮优化重做（进行中），外交/盟约契约以 §8 当前描述为准，最终门禁数字待 PI。
> 本文件以冻结源码与最终 config 为依据。v2 功能接线已完成并完成只读审查；全量测试、typecheck、生产 build/validate 与 smoke 已有最终阶段结果。AI 108 局与 source archive 仍是本次最终交付的待项，不能用 v1.x 数字替代。
> 战场数值集中在 `src/config/balance.ts`，时长在 `src/config/modes.ts`，地图与路线在 `src/maps/` / `src/core/reachability.ts`。局外成长在 `src/ui/progression.ts`，颜色在 `src/ui/player-colors.ts`；它们不向战斗注入属性加成。

## 1. 当前可玩范围

- 三种离线对局：普通单人可选 1 玩家 + 1/2/3 AI（共 2/3/4 方，默认两方）；异步挑战赛按码锁定两方/三方/四方与其他比较条件；同屏双人对战为固定两方 1v1，无 AI。各阵营独立计分，中立地独立。
- 速度三档 0.75× / 1× / 1.25×：单人、挑战、双人共用；只缩放真实时间累积，不改变核心 tick 与规则。新档默认 0.75×，v1.1 及更早存档保持 1×；对局中切速把本局降为练习（不计榜、挑战码不可比）。
- 单人局可携带局外「叛变」技能等级；挑战赛与双人对战均关闭叛变（见 §7.1 / §7.3 / §7.4）。
- 指挥官档案（昵称 + 预设头像）为本地登录：存档在平台 KV/localStorage，无账号、无联网；金币与叛变等级随档案本地保存。
- 地图库：由真实美国州界共享边离线生成的 **144 张连续区域图**（3 主题 × 12/18/24 州 × 每档 16 张，`atlas_<theme><size>_<nn>`）。
  - `plains_crossroads`（平原战场）：开阔多路，无战略隔断。
  - `mountain_pass`（山脊战场）：两侧各连通，仅两处真实州界作为山口，其余山脊不可通行。
  - `river_valley`（河谷战场）：两岸各连通，仅两处真实州界作为桥头，其余河段不可通行。
- 新局不选图：设置包含时长/难度/速度；每个 seed 由核心库确定一张具体 atlas 地图，同 seed 同图。旧 9 个显式变体（`plains_crossroads_12` 等）仍可被 API/测试显式引用，但不再出现在设置页。
- 几何来源：U.S. Census Bureau 2017 cartographic state boundaries，经 `us-atlas@3.0.1`（Public Domain 几何 + ISC 打包）。runtime 只含压缩后的生成数据，raw/SOURCE/license 不进 runtime，进 source 归档。
- 地块面积来自真实投影面积（areaUnits）；面积驱动可见大小与容量，不按屏幕像素重算。
- 地形：plain / forest / hill / mountain 全部生效；可通行边由真实共享边构成。
- 领地面向 UI 提供 `shortName`、`labelAnchor`（必要时 `labelLeader`）；渲染、命中与测试都按这些字段定位，不依赖数组顺序。
- 难度显示从低到高为新手（`casual`）、休闲（`easy`）、标准（`normal`）、困难（`hard`）。共用核心战斗与出兵校验；`casual` 的起兵/经济参数以当前 `balance.ts` 与生产代码为准，不能把它描述为「只有 AI 决策参数不同」。
- 玩家主动技能「叛变」与全局随机事件「天灾」见 §7.1 / §7.2；等级与解锁由局外配置传入。
- 分享/保存已接入结果页；无 SDK 时只做浏览器海报预览，按钮隐藏/禁用。
- 首页设置页收纳本机排行榜开关、音效开关与「重置存档」；速度在开局设置页与暂停页选择，音效默认开启、可关闭。指挥官页/成长页可保存预设玩家颜色、查看 XP/等级与签到状态；颜色只影响显示配色，不能改变战斗数值。

## 2. 一局流程

加载 → 首页 → 指挥官档案（首次创建/登录）→ 设置（时长/难度/速度，无地图选择）或挑战赛输码或双人对战 → 教学（首次）→ 3-2-1 倒计时 → 对局 → 结算 → 重开/回首页。

每局开始时 UI 只生成一次 seed（挑战码局使用码内 seed）；`createMatch` 先 normalizeSeed，再由种子选图。挑战赛的 seed/时长/难度/速度来自挑战码（旧 SC 码不带速度，按当前设置并以练习处理）；双人对战沿用设置中的时长与速度。规则状态由 `MatchStatus: ready | playing | paused | ended` 表示；只有 `playing` 接受指令与推进 tick。

## 3. 领地、接壤与出兵

- 地图是图：节点为领地，`state.edges` 是**真实 passable edge**；不可通行边界不产生 edge。
- source 必须属于出兵方；目标若与 source 有真实 passable edge，可直接派兵。后方来源不必直接邻接目标，但必须经真实 edges 穿过**己方连通领地**到达某个与目标接壤的己方 frontier，再走最后一条真实 edge。
- v2 删除**断连 source → frontier 的直线 fallback**；source 所在分量无法到达 frontier 时 `planMoveRoute` 返回 null，命令按 `not_adjacent` 原子拒绝，不扣兵。己方增援同样遵守真实路径规则，不能选来源自身。
- 不能穿过敌方或中立领地作为中间节点；中立格可作为扩张的最终目标，中立自身不能出兵。与某方存在活动盟约（停战）时，其领地可作为借道节点与攻击前沿（仅打中立或共同敌人），但盟友自身永不可作为攻击目标；所有路径仍必须是真实 passable 边构成的己方/盟友连通通路，没有断连 fallback（shared attack range，见 `src/core/reachability.ts` 与 §8）。
- 多个己方来源可分别向同一目标派兵，抵达时依次独立结算。
- 发出后的 `routePoints / arrivalTick / owner` 冻结；途经地/来源随后易主不重算路线，因此可能看到军队继续走过已变色区域。这是 dispatch 时路径与当前版图的差别，不能单凭画面断言绕过校验器。

实现：`src/core/reachability.ts`、`src/core/commands.ts`、`src/game-api.ts`。

## 4. 派兵：比例、单次与持续兵线

**单次派兵（single）**：保留原长按比例与安全驻军规则。

- 按住 0 ms：比例 20%；1000 ms：100%；中间线性（如 500 ms ≈ 60%）。
- 拖动超过 10 CSS px 后**冻结**比例，松手才提交。
- 取消：空白/非法目标、拖回来源、pointercancel、失焦、暂停、来源已失守；取消不扣兵。
- 派兵公式：

```text
reserve   = max(1, ceil(troops * 0.15))
available = max(0, troops - reserve)
sent      = floor(available * ratio)
```

“100%”指派出全部**可调动**兵力，仍保留至少 15%（且至少 1 兵）。
参数：`MIN_DISPATCH_RATIO=0.2`、`FULL_HOLD_MS=1000`、`RESERVE_RATIO=0.15`。

**持续派兵（continuous，默认）**：一次拖动建立/操作兵线，之后由核心按节拍自动派波。

- 己方 source 拖向接壤目标且该 source 无同目标兵线 → 建立兵线；同一 source 再拖同一目标 → 停止；拖另一目标 → 改道（旧线停止、新线建立，已在途波次仍按冻结目标落地）。
- 每个 (owner, source) 最多一条兵线；兵线只在任意己方 frontier 可达目标存在时建立，规则与 §3 一致。
- 每 15 tick（1.5 s）派出一波；单次可派不足 4 兵时本拍不派、等待产兵；同一兵线在途波次上限 8，满额时等待空位再派，不因时长、改道或连续未攻下自动取消。
- 来源失守、路线失效、手动停止会取消；目标被攻下后兵线保留并转为增援。对局结束后不再派波。取消后已在途波次仍会落地，按**普通单次攻击**结算，不写入兵线记录。
- 每一波都是真实 `Army`，来源只扣一次；没有跨波累积伤害、没有预扣、没有攻击力继承。
- 双人：双方共用「连续/单次」开关，但兵线与「停止兵线」按各自 owner 独立，不能跨分隔线操作。
- AI 不建立兵线（planner 不调用 `issueFront`），但克隆与短程预测会重放兵线阶段。
- 参数（`src/core/fronts.ts`）：`CONTINUOUS_MIN_BATCH=4`、`CONTINUOUS_SEND_INTERVAL_TICKS=15`、`CONTINUOUS_MAX_WAVES_IN_FLIGHT=8`；这些常数尚未迁入 `balance.ts`，不视为最终平衡值。

实现：`src/input/gesture-controller.ts`、`src/core/dispatch.ts`、`src/core/fronts.ts`、`src/ui/v120-fronts.ts`。

## 5. 容量（由逻辑面积决定）

```text
capacity = clamp(round(20 + 30 * sqrt(areaUnits / referenceArea)), 30, 120)
```

- `areaUnits` 是地图数据属性；Canvas 缩放、屏幕像素不参与容量。
- 满员停止产兵；援军溢出按容量截断（超过容量的部分不驻扎）。
- 攻占后驻军也按目标容量截断。
- 每块领地在快照中都有 `capacity`，UI 选择态显示 `当前驻军/容量`。

实现：`src/core/capacity.ts`。

## 6. 自动产兵与三条升级线

所有升级即时生效、原子扣兵，必须 `troops > cost`，至少留 1 兵；被攻占后该地所有升级重置。

### 6.1 产兵（production）

| 等级 | 每秒产兵 | 升到本级消耗 |
|---|---:|---:|
| Lv1 | 0.80 | 初始 |
| Lv2 | 1.15 | 10 |
| Lv3 | 1.55 | 20 |

- 中立地不产兵；玩家与 AI 领地每 tick（0.1 s）产兵一次。
- 小数进度 `productionRemainder` 保留在 `[0,1)`；只增加整数兵；满员时清零。

### 6.2 行军（march）

| 等级 | 速度倍率 | 升到本级消耗 |
|---|---:|---:|
| Lv1 | 1.0× | 初始 |
| Lv2 | 1.2× | 10 |
| Lv3 | 1.4× | 20 |

- 行军等级在**派兵瞬间**冻结进该军队的 arriveTick；之后升级不会让已在途军队加速。

### 6.3 城防（defense）

| 等级 | 效果 | 升到本级消耗 |
|---|---|---:|
| 0 | 无 | 初始 |
| 1 | 城墙，护盾容量 12 | 12 |
| 2 | 炮台，护盾容量 24 | 20 |

- 护盾是**独立兵力池**：不计入驻军、不参与派兵可调动量；进攻失败时先扣护盾，再扣驻军。
- 升级只增加护盾容量并补入新增容量，不免费修复已损失护盾。
- 任何势力（含 AI）都可升级并开炮；中立地不产兵、不开炮。

## 7. 地形、行军、炮击与战斗

地形防御只在**守方**生效（整数百分比）：

| 地形 | 加成 |
|---|---:|
| plain | 0% |
| forest | 15% |
| hill | 25% |
| mountain | 40% |

行军时长（direct 边保持旧公式；非 direct 按真实各段累加）：

```text
direct: travelSeconds = clamp(0.75 * travelFactor * (bridge ? 1.35 : 1.0) / marchSpeedMultiplier, 0.35, 3.5)
非 direct: 同己方 BFS 到 frontier；各真实段按段长 × travelFactor / 桥倍率累加；
          无同连通路径时，source→frontier gap 使用最终 target edge 的 travelFactor 比例，gap 不吃桥倍率；
          总秒数 clamp 后 ceil 到 tick，再按 dispatch 时行军等级加速。
arrivalTick = dispatchTick + max(1, ceil(travelSeconds / 0.1))
```

路线 `routePoints`、`arrivalTick` 出兵时冻结；后续易主/行军升级不改变。

炮击（城防 Lv2）：

- 每 8 tick（0.8 s）最多一发；`cannonReadyTick` 是下一次可开火 tick。
- 目标为炮塔所属方的敌军在途军队；使用与渲染/AI 相同的真实折线路线和本 tick 扫过线段，不读 UI/canvas。
- 造成 2 点真实伤害（不足则打光）；命中后更新冷却。炮塔易主时冷却与城防重置。
- 炮击事件字段：`type=cannon`、`targetId=炮塔`、`amount=伤害`、`owner`、`targetArmyId`、`from=炮塔锚点`、`to=进入射程的命中点`；事件只供表现，不参与规则决策。

战斗（整数、平局有利守方）：

```text
totalDefence = target.troops + target.shield          // 护盾与驻军一起构成防御总量
requiredCost = ceil(totalDefence * (100 + terrainPct) / 100)

if attackerTroops > requiredCost:
    captured  = true
    survivors = attackerTroops - requiredCost
    newGarrison = min(target.capacity, survivors)
    productionLevel = 1, marchLevel = 1, defenseLevel = 0, shield = 0
else:
    captured  = false
    defenderLoss = ceil(attackerTroops * 100 / (100 + terrainPct))
    先扣护盾，剩余伤害再扣驻军（驻军至少留 1）
```

- 同阵营抵达 → 增援，`troops = min(capacity, troops + arriving)`，溢出丢弃。
- 多支军队同 tick 抵达按 `arrivalTick ASC, armyId ASC` 依次结算；后到者可能攻击刚易主的目标。
- 在途军队之间不发生空中交战，只在抵达时结算。
- 中立受攻击失败后：3 s（30 tick）冷却，之后以 0.35/s 回复到该地初始驻军，不超过初始值。

兵线波次（`resolveFrontBattle`，仅持续兵线使用）：

- 捕获门槛与单次完全相同：`attackers > requiredAttackCost(garrison + shield, terrain)`，地形与护盾不能绕过。
- 未攻下时按真实前后差值扣护盾/驻军，守方仍保底 1 兵；最小 4 兵波次可打穿仅剩 1 兵的守军，这是兵线能磨掉守军的原因。
- 不跨波累计伤害、不预扣、不继承攻击力；每波独立结算，来源只在该波派出时扣一次。

真实防守反馈：

- 未攻下时，单次攻击在造成真实损失后、兵线波次每次都会发出 `defend` 事件：`targetId`、`owner`（守方；中立无 owner）、`amount`（真实总损失）、`shieldLoss`、`troopLoss`、`targetArmyId`；兵线波次另带 `siege` 标记。
- `capture` 事件负责占领飘字与音效；`front` 的 capture 不再重复表现。UI 只消费核心事件，不自行计算命中或伤害。

实现：`src/core/combat.ts`、`src/core/movement.ts`、`src/core/cannon.ts`、`src/core/army-route.ts`、`src/core/fronts.ts`。

### 7.1 叛变（玩家主动技能）

- 等级 0~5 由局外配置传入，0 = 未解锁禁用；每级策反额度 `10 * 等级`。
- 开局 300 tick（30 s）后可用；每次成功发动后冷却 600 tick（60 s）。
- 目标必须是 AI 领地（ai1 / ai2）。优先池 = 驻军 ≤ 额度 × 1.5 的敌格，池内用**对局主 RNG** 均匀抽取；池空时选驻军最少的敌格（同兵力取 territoryOrder 靠前者）。
- 策反数 `removed = max(1, min(额度, 目标驻军 - 1))`：至少 1，通常给守方留 1；只有 1 兵的目标会被整格策反（守方剩 0）。
- 策反部队立刻按 §7 战斗规则攻打原地：守方总防御 = `(目标驻军 - removed) + shield`，攻方 = `removed`；地形加成、护盾优先扣减、平局守方胜全部复用 `resolveBattle`。
  - 攻下：`survivors = removed - requiredCost`，按目标容量截断后落格；产兵/行军/城防三线、护盾、炮台冷却按易主规则清零，owner 改为玩家。
  - 攻不下：策反部队全灭；守方按防守失败规则扣减（先护盾后驻军），驻军至少留 1。
- 未解锁 / 冷却中 / 无敌格 / 非对局中一律带明确 reason 拒绝（`locked` / `cooldown` / `no_target` / `not_playing`），不消耗 RNG、不改变状态。
- 双人对战中叛变不可用：`issueBetrayal` 恒返回 `locked`，不消耗 RNG、不改变状态。挑战赛双方叛变技能关闭（见 §7.3）。
- AI 不使用叛变技能（当前实现；技能只由玩家指令触发）。
- 参数：`BETRAYAL_SOLDIERS_PER_LEVEL=10`、`BETRAYAL_INITIAL_DELAY_TICKS=300`、`BETRAYAL_COOLDOWN_TICKS=600`、`BETRAYAL_TARGET_POOL_FACTOR=1.5`；局外 5 级价格见 §7.5。

实现：`src/core/skills.ts`、`src/core/engine.ts`（`MatchEngine.issueBetrayal`）。

### 7.2 天灾（全局随机事件）

- 每局 0 或 1 次。开局由**独立派生 RNG**（seed 哈希 ^ 固定盐，mulberry32）决定，不消耗对局主 RNG，因此既有 AI 决策的随机序列不变。
- 触发概率 35%；触发时刻 = `round(总 tick 数 * (0.25 + r * 0.35))`，r 为独立 RNG 的 [0, 1) 均匀值。
- 触发前 30 tick（3 s）把 `disaster.warned` 置 true 供 UI 预警（核心只负责标记）。
- 到达触发 tick 时对**全场每个领地**（玩家 / AI / 中立）独立结算：若 `troops > 1`，r 在 [0.10, 0.20) 均匀取值，`loss = floor(troops * r)`，`troops = max(1, troops - loss)`；1 兵格不受影响。
- `shield` 与 `productionRemainder` 不变；中立地按受击处理，记录 `lastDamagedTick`（沿用 §7 的 30 tick 静默 + 0.35/s 恢复到初始驻军）。
- 结算后 `disaster.struck = true`，本局不再触发。
- tick 顺序（两条推进路径一致）：`tick+1 → 天灾预警/结算 → AI 决策 → 炮击 → 抵达结算 → 产兵/中立恢复 → 兵线派发（resolveContinuousFronts） → 统计与胜负判定`。
- 参数：`DISASTER_CHANCE=0.35`、`DISASTER_WINDOW_START_RATIO=0.25`、`DISASTER_WINDOW_END_RATIO=0.60`、`DISASTER_MIN_LOSS_RATIO=0.10`、`DISASTER_MAX_LOSS_RATIO=0.20`、`DISASTER_WARN_TICKS=30`。

实现：`src/core/disaster.ts`、`src/core/engine.ts`（tick 插入）。

### 7.3 异步挑战赛（挑战码，v2 当前口径）

- 挑战码有三族：
  - 历史 `SC-XXXXXX-XXXXXX`：16 字符，12 位 base36，不含速度与规则版本；仍可输入，但只作同图练习。
  - 两方 `SV-XXXXXX-XXXXXX-XX`：19 字符，14 位 base36；载荷含 seed、时长（180/300/480 s）、难度、控地分、战绩摘要、速度（0.75/1/1.25）、规则版本与 `fair`/`practice`。
  - 三/四方 `SM-XXXXXX-XXXXXX-XX`：与 SV 同形，额外携带 `factionCount=3|4`；两方不进入 SM 族。
- 当前源码常量 `CHALLENGE_RULES_VERSION=2`；旧规则版本仍可解码并按不同比较组处理。输码按码内 seed/时长/难度/速度/方数开同图对局。
- 可比条件由接受码与本局共同决定：SV/SM、`fair`、规则版本为 2、速度与码一致且全程未切速、叛变等级为 0、方数一致；满足后以玩家控地分和码内目标分比较，严格更高 = `win`，相等 = `draw`，更低 = `lose`。
- `practice`、旧 SC、规则版本不一致、中途切速或使用叛变的局按普通单人结果处理，不使用挑战目标判胜，不进入固定可比榜，界面说明练习原因。挑战码不是安全令牌，玩家可以自行修改后再分享。
- **已批准但待 PI 最终 gate**：认输计负、不入榜、不生成可比挑战码；认输局（普通单人或挑战）不发放金币与经验（0/0），歼灭/超时/僵局的胜负奖励保持原路径；当前文档波次不把尚未收口的 finish gate 记为通过。僵局结算是否影响挑战/榜单资格须以最终政策确认，不在文档中自行增加限制。
- 挑战/教学/同屏双人均禁用外交；普通单人外交为提议制盟约（三轮优化后口径，详见 §8）。
- 挑战目标分数为 0 的码仍由入口拒绝；codec 保留 0 的编解码边界。无网络、无账号，挑战码通过文本传播。

实现：`src/core/challenge.ts`、`src/ui/challenge-screen.ts`、`src/ui/app-shell.ts`；当前规则版本由 `CHALLENGE_RULES_VERSION` 提供。

### 7.4 双人对战（同屏 1v1）

- 同一设备 1v1：蓝方 = player，红方 = ai1 owner 槽位；**不运行 AI planner**，双方都是人类。
- 双 Canvas 分屏：竖屏红方在上（整体旋转 180°）、蓝方在下；横屏蓝方在左、红方在右，文字正向。两个视图共享同一场对局与内核，各有独立选择/蓄力/兵力/缩放平移，可同时操作；跨分隔线不夺控；时钟、天灾、胜负与结算只执行一次。
- 双指各控一色：只能从自己颜色的领地出兵，跨色来源原子拒绝；改方向时取消未提交手势。
- 派兵模式两方共用「连续/单次」开关，但每条兵线与「停止兵线」按 owner 独立，不能跨分隔线操作。
- 无战场升级：双方都不能购买产兵/行军/城防，炮台不会出现；城防/护盾保持初始。
- 叛变不可用：`issueBetrayal` 恒 `locked`，不消耗 RNG。
- 外交不可用：不提供停战/解除停战入口，不能把双人对战当作外交模式。
- 玩家局外预设颜色不改变 versus 的固定蓝/红双方配色（PI 收口后复核具体渲染接线）。
- 天灾照常：与单人相同概率/窗口/伤害，对全场所有领地对称结算。
- 双人对战不发金币、不计入档案胜负统计（profile.stats）；最近对局列表保留双人条目（带「双人 · 蓝胜/红胜/平」标签），不生成挑战码；结算页只展示本局结果。
- 限时判定沿用 §8：依次比较控地分、领地数、驻军 + 在途兵力，仍相同为平局；蓝方胜 = `win`，红方胜 = `lose`。
- 速度沿用设置中的档位，暂停页可切速；双人不参与榜单，切速不产生额外排名后果。

实现：`src/core/engine.ts`（`mode: 'versus'`）、`src/input/gesture-controller.ts`（多指）、`src/ui/versus-pane.ts`、`src/ui/v120-fronts.ts`、`src/ui/app-shell.ts`。

### 7.5 指挥官档案与金币经济

- 档案（本地登录）：昵称 1~12 字符 + 8 个代码绘制的预设头像之一；字段 `schemaVersion / nickname / avatarId / gold / betrayalLevel / stats / createdAt`，存储在平台 KV（`state-conquest:profile`）。
- 金币：胜 easy 50 / normal 120 / hard 300；平 = 对应难度 30%（四舍五入）；负 = 10。挑战赛按同一规则；双人对战不发金币。
- 叛变升级：逐级购买，价格 Lv1 150 / Lv2 400 / Lv3 900 / Lv4 1800 / Lv5 3500；不可跳级、余额不足或满级时明确拒绝且不扣款；购买只影响下一局。
- 金币、XP、指挥官等级、签到状态与玩家预设颜色仅保存在本机；清除缓存/换设备即清零，且不防篡改。v2 成长实现使用本地自然日键；同一天重复签到拒绝，连续上一自然日则延续并封顶 7 天，断档从第 1 天重新计算。`src/ui/progression.ts` 当前等级上限为 12，XP 阈值与签到奖励由该模块提供；这些值是局外进度，不进入战斗计算。
- 存档损坏：加载返回 `corrupt` 并把原载荷备份到 `state-conquest:profile-backup`，不静默伪造档案；存储读失败单独报告。

实现：`src/ui/profile-store.ts`、`src/ui/profile-screen.ts`、`src/ui/upgrade-screen.ts`、`src/config/balance.ts`。

### 7.6 本机排行榜（纯本地）

- 首页设置页开关，默认关闭；关闭后停止入榜并隐藏榜单内容、保留已有记录；只记录开启后完成的单人/挑战赛，双人排除。
- 存储键 `state-conquest:leaderboard`；当前 schema **3**，可读 schema 1/2/3。schema 1/2 的旧行按两方记录读取；新行明确记录 `factionCount=2|3|4`。当前规则版本常量为 **2**。
- 分组 key：`rankClass`（fixed/practice/legacy）+ 地图 + seed + 难度 + 时长 + 方数 + 模式/叛变等级 + 速度 + 规则版本；不同方数、速度或规则版本不合并。
- `fixed`：当前规则版本、全程未切速、技能状态允许的单人/挑战成绩；`practice`：切速、练习码、规则版本不一致或使用叛变的局，记录但不排名；`legacy`：旧行。已批准认输不入榜，最终由 PI 接线后复核；僵局结算的资格不在文档中自行变更。
- 组内排序：分数降序，同分先完成者在前，再按记录 id；用时只展示不参与排名。每组上限 20 条（组内低分先淘汰）；现代记录（fixed+practice）预算 100 条，历史（legacy）独立预算 100 条（不超过实际迁移数量），两者互不挤占；全局预算内最早完成者先淘汰，并显示淘汰数量。
- 写入失败、容量淘汰与「本局未保留」均可见；重置存档后物理存储与内存均为空。

实现：`src/config/leaderboard.ts`、`src/ui/leaderboard-store.ts`、`src/ui/leaderboard-screen.ts`。

## 8. v2 外交（盟约）、僵局与认输（当前实现，三轮优化重做后口径）

> 外交在三轮优化中重做：开局不再有默认全场停战，也不存在「每对无上限、默认同意」的旧口径；本节以当前源码为准（00-baseline 备份保留旧口径，不代表本节）。

- **入口与双向提案**：外交只对普通 solo 开放。玩家在暂停面板点「外交」打开提案视图（`pause-screen.ts` 的 `data-action="diplomacy"` → `diplomacy-view.ts`），逐方调用 `proposeTruce(state, owner, target, decide)`；AI 主动提议由引擎在固定 tick 扫描中调用 `scanAiTruceOffers(state, decide)`。两条路径共用 AI 自身利益评估：玩家提议时评估接收 AI；AI 主动时评估发起 AI，两者都以 `evaluateTruceProposal(state, selfAI, player)` 中的 AI 视角判断。玩家对 AI 邀请的接受/拒绝由用户明确选择，不由该评估代替。玩家提案的 `ok` 只表示请求合法并进入决策，不等于接受。
- **自身利益评估与 AI 扫描**：`evaluateTruceProposal(state, self, other)` 是确定性纯评估，不使用随机或墙钟。实力由驻军、在途兵力、控地分值 ×0.4 与实际产兵速率乘最多 15 游戏秒剩余时间组成；第三方压力、共同威胁、真实可借道新增目标、交界压力和弱势自保按真实路径/成本计入，接受阈值为 30，并保留己方明显领先、提议方超过接收方两倍等否决。AI 首次在 200 tick（20 游戏秒）后、此后每 50 tick（5 游戏秒）扫描；只在普通 solo、存活方至少 3、玩家与候选 AI 均无活动盟友时提议。候选按实际 `score` 选最高者，平分时使用 `activeOwners` 的稳定顺序（严格 `>` 保留先出现者）。
- **待处理邀请**：AI 提议写入 `pendingOffer`，有效 150 tick（15 游戏秒）；pending 记录的 `expiresTick` 不构成活动盟约，因此未接受前不共享路径、不改变敌我关系、不增加 `uses`。全局最多保留 1 条 pending offer；同一 pair 在 pending 或 pair 冷却期间不重复提议。`aiOfferCooldownUntilTick` 记录 AI 邀请响应、过期或失效后的全局 300 tick（30 游戏秒）抑制。
- **玩家响应与冷却**：玩家明确调用 `acceptTruceOffer(offerId)` 后，核心重新检查对局状态、邀请有效期、双方存活、至少 3 个存活方及双方盟友上限，合法时才建立 600 tick（60 秒）盟约并 `uses + 1`；接受使用邀请中已保存的评估因素，不把 pending 预先当作盟约。`rejectTruceOffer(offerId)`、过期和失效只清除 pending、记录结果并设置 pair/global 300 tick 冷却，不增加 `uses`；core 通用 cooldown 记录不等于 AI 重新评估后的拒绝。玩家提案仍通过 `proposeTruce` 由同一 decider 评估，接受建立盟约，AI 拒绝只留下 pair 冷却。
- **成立约束与记录**：每方最多 1 个活动盟友（任一侧已有 → `ally-limit`）；存活方 ≥3（`too-few-alive`）；同对已有活动盟约或冷却中 → `already-allied` / `cooldown`。开局 `createDiplomacy` 为空 `truces`，无默认停战。可选元数据包括 `pendingOffer`、`aiOfferCooldownUntilTick`、`lastDecisionKind`、`lastDecisionProposer`、`lastDecisionResponder`、`lastDecisionOutcome`（`accepted` / `rejected` / `expired` / `invalidated`），并与已有 `lastDecision`、`lastDecisionTick`、`lastDecisionReason`、`lastDecisionFactors` 一起按实际存在条件复制到 snapshot；legacy 记录可缺少这些字段，hash 保持旧记录兼容。
- **UI 响应边界**：运行中的对局收到有效 AI 邀请时，在到达 tick 复用真实暂停机制，冻结对局与邀请计时并直接弹出决策；不再显示顶部邀请条。弹窗展示发起方、实际 AI 理由及因素、60 游戏秒停战/借道与接受后按练习处理的后果，只有「接受合作」「拒绝」两个按钮；初始焦点在拒绝，Tab 在两按钮间循环，遮罩和 Esc 不接受、不拒绝也不关闭。答复使用该条邀请的真实 id；原本运行中才在答复后恢复。已有暂停页或其它弹层时先延迟，不覆盖现有模态，在继续对局的安全出口展示，答复后仍保持暂停。每局每条邀请最多自动展示一次，退出/重开清理弹窗与守卫，同种子新局也会重新接收；过期或失效显示未生效，不冒充 AI 拒绝。玩家主动从暂停页提议停战的路径保留。
- **时长、解盟与 uses**：接受后盟约持续 600 tick（60 秒）；活动盟约到期或手动撕毁后进入 300 tick 冷却，拒绝/过期/失效不改 `uses`；成立或撕毁各 +1，`uses > 0` 的普通局为 `practice`，不排名、不 mint 可比较公平码。存活方降至 2 或盟友被淘汰时自动解盟；本局结束（含 resign）清理待处理邀请；手动撕毁（`breakTruce`）立即转敌对并进入冷却。
- **共享通路**：已接受盟约存续期间双方构成一张通行网络——盟友领地可作借道节点与攻击前沿（打中立或共同敌人）；兵源仅限己方（盟友驻军不可动用、不控盟兵），盟友自身永不可作为攻击目标（hostile-target gate）；路径必须是真实 passable 边构成的己方/盟友连通通路。AI 邀请尚未接受时不享有这套共享通路。
- **借道操作与诊断**：按住己方兵源，直接拖向盟友前沿后的中立或共同敌人；不能先派兵进盟友地再指挥盟兵。`sourceReachability` 分别返回可落点与盟友前沿，地图用不同标记呈现；`inspectMoveRoute` 与实际命令共用路线规划，成功预览附 `frontierId / territoryIds / transitOwners / edgeIds / routePoints`，Canvas 按真实 routePoints 画线。失败区分兵源非己方、目标为盟友、没有前沿、兵源断连、山河阻断、旧盟约结束；只有移除阻断确实恢复整条路线时才归因山河，只有恢复实际旧盟约确实恢复路径时才归因盟约结束，不能凭画面猜原因。
- **解盟的兵线语义**：解盟/撕毁即时取消两类兵线——指向前盟友领地的兵线、因共享网络消失而失去合法路线的借道兵线（`cancelFrontsForEndedTruce`）；**已经在途的军队不动**，按冻结 route/arrival 走完并按普通抵达结算（含抵达（前）盟友目标时的一次原地退款）。
- **模式门禁**：挑战（包括旧码/练习码）、教学和 versus 禁外交（`app-shell.ts` 创建时 `diplomacyEnabled: !tutorialMode && !activeChallenge && !versus`，`createMatchState`/教学 adapter 侧同样显式关闭）；禁用模式下无入口且核心拒绝。
- **僵局**：`lastProgressTick` 由真实占领或真实防守损失更新；连续 60 秒无有效进展显示预警，连续 120 秒结束，按既有 `decideTimedOutcome` 的「控地分 → 领地数 → 驻军 + 在途兵力」比较。预警/结束常量当前为 `STALEMATE_WARNING_TICKS=600`、`STALEMATE_END_TICKS=1200`。
- **认输**：`resign()` 将本局标为 `lose`、`endReason='resign'`。认输计负、不入本机榜、不生成可比挑战码，且不发放金币与经验（`ProfileStore.settleMatch` 以 `rewardable:false` 结算：战绩照记负局、单次持久化、档案 schema 不变）；歼灭/超时/僵局的胜负奖励保持原路径。结果 records、leaderboard 与挑战码 gate 按冻结 app-shell 接线执行。

实现：`src/core/diplomacy.ts`、`src/core/invariants.ts`、`src/core/fronts.ts`（`cancelFrontsForEndedTruce`）、`src/core/engine.ts`（两段 `maintainDiplomacy`）、`src/core/reachability.ts`（shared attack range）、`src/core/stalemate.ts`、`src/ai/diplomacy-evaluate.ts`、`src/game-api.ts`、`src/ui/pause-screen.ts`、`src/ui/diplomacy-view.ts`、`src/ui/game-screen.ts`（盟友 HUD/路线反馈）、`src/ui/app-shell.ts`。

## 9. 结束条件与计分

阵营“存活” = 至少一块领地 **或** 仍有在途军队。

- 玩家无地且无在途 → `lose`；双方都无地无兵 → `draw`。
- 所有 AI 均无地且无在途 → `win`（中立地可剩余）。
- 倒计时归零：依次比较
  1. 控地 `scoreValue` 总和；
  2. 领地数量；
  3. 驻军 + 在途兵力总和；
  4. 仍相同 → `draw`。
- 多 AI 时玩家必须严格领先所有对手才算胜利，与最高者完全相同为平局。

实现：`src/core/score.ts`。

## 10. AI 参数（当前实现）

| 参数 | easy | normal | hard |
|---|---:|---:|---:|
| 决策间隔 | 3.0 s | 1.6 s | 0.7 s |
| 单轮最多指令 | 1 | 1 | 2 |
| 主动等待概率 | 25% | 8% | 2% |
| 对敌方额外兵力余量 | 8 | 2 | 0 |
| 评分抖动量级 | 6 | 3 | 1 |
| 候选 Top-K | 不截断 | 4 | 6 |
| 前线守备比例 `guardShare` | 0.20 | 0.22 | 0.25 |
| 主动增援受威胁前线 | 否 | 是 | 是 |
| 升级 ROI 回本系数 | 2.4 | 1.8 | 1.6 |
| 多源协同 | 无 | 无（字段为 simple，未启用） | 完整双源 |
| 短程模拟步数 | 0 | 1 | 3 |
| 预测敌方反击波 | 0 | 0 | 1 |

- AI 与玩家共用 `computeMovePlan / applyMove / computeUpgradePlan / applyUpgrade` 与 any-frontier reachability；无资源作弊、无内部捷径。
- 候选来自 `ownerAttackTargets` 与真实 `planMoveRoute`；TopK 截断前排除已规划 target，第二指令位在新 working clone 上重新规划，不能重复同一 target。
- AI 会在产兵/行军/城防三条线间按真实 pressure/post-cost reserve 选择；zero-pressure home 不买无用墙；进攻预测包含目标护盾与当前 tick 炮击相位。
- 决策顺序：受威胁前线增援（risk ≥1.25）→ 单源进攻 → 困难双源协同（需两个指令位）→ ROI 升级 → 普通增援。
- `WAIT` 合法：无正效用动作时不出兵。
- AI 不建立兵线（planner 不调用 `issueFront`），但克隆与短程预测会重放 `resolveContinuousFronts`，因此会把玩家兵线造成的失地风险计入判断。

实现：`src/ai/planner.ts`、`src/ai/evaluate.ts`、`src/ai/forecast.ts`、`src/ai/clone.ts`、`src/config/balance.ts`。

## 11. 输入与界面规则

- Pointer Events 统一鼠标/触摸；单人模式第二触点取消当前派兵；双人分屏双指并发、各自独立蓄力。
- 选中己方领地显示快捷信息；长按显示比例环；拖动实时显示合法性和战斗预估。
- 地图上方派兵条：连续/单次切换与「停止兵线」；双人每侧一个停止按钮，只作用于自己的兵线。
- 顶栏常驻速度 chip（0.75×/1×/1.25×）；暂停页提供三档速度，切速提示「本局不计排名」。
- 首页设置页提供音效开关与状态说明（不可用时显示真实原因）。
- 玩家蓝、AI1 红、AI2 橙、中立灰；数字始终可见。
- 选中态底部并列三条升级按钮：产兵、行军、城防；高度固定，显示当前等级/消耗，满级显示已满。切换选择、普通领地、城防 Lv1/Lv2 不挤压 canvas。
- 城防达到 Lv2 显示炮台与炮圈；升级图标 SVG 复用，steady tick 不重建。
- 暂停/失焦/切后台停止 tick 并静音音效；恢复需玩家点击继续，不补算后台时间，音效恢复时自动尝试 resume，若浏览器仍要求手势则再触屏激活。
- 结算页展示胜负、地图、难度、时长、用时、控地分、占领数、最高控地，并生成 750×1200 战报长图预览；练习挑战显示练习原因，不显示挑战胜负。
- 保存到相册/发笔记仅在平台能力存在时显示，且只在用户点击后调用；无 SDK 时只保留浏览器预览和说明。

实现：`src/ui/app-shell.ts`、`src/input/*`、`src/rendering/*`。

## 12. 确定性与可复现

- 固定 100 ms tick；速度只缩放真实时间累积（0.75×/1×/1.25×），单帧最多追 3/3/4 步（0.75×/1×/1.25×），单帧 elapsed 上限 300 ms，超限丢弃积压。
- 所有随机决策来自 seeded PRNG；UI 每局只取一次 seed，核心先 normalizeSeed 再选图。
- 相同 seed + 相同 tick 指令序列得到相同状态；速度不改变核心状态，只改变到达同一 tick 所需的真实时间。
- 同 seed 的地图身份与 geometry fingerprint 稳定；兵线状态进入快照并随对局克隆，不依赖 UI 计时器。
- 叛变目标选择消耗对局主 RNG（与玩家指令位置绑定）；天灾的调度与逐格伤害使用独立 seed 派生 RNG，不改变主 RNG 序列。
- 渲染与输入不直接修改 `MatchState`，只调用 `game-api`；炮击只由核心事件产生，渲染不重算。

## 13. 当前验证与历史记录

- **v2.0.0：本地开发、验证与打包完成，平台验收待完成**。`npm test` 885/885、typecheck PASS；生产 build、validate、smoke 第二轮 **22 scenarios / 577 passed / 0 failed / 0 blocked** 与正式 AI108 **108/108（hard54 / greedy54 / draw0）** 已 PASS；runtime package 已通过官方 ZIP audit 与解压重审计，ZIP 为 376,003 bytes、SHA-256 `e627e68cc2f3f3ad4b8517dacbf9205c219cae24912490e3ac3172a7369d3b7a`。源码归档已真实 PASS：`release/v2.0.0/state-conquest-v2.0.0-source.zip` 共 221 files，逐文件与工作区一致，runtime manifest 已同步 `sourceArchive` 且 `sourceArchiveVerified=true`；生成结果、大小、SHA 与逐文件校验以外置 `artifacts/v2.0.0/source-manifest.json` 为权威，不能外推平台验收通过。
- 本版真实浏览器视觉/完整 GUI、原生 9.51 关注确认、Chrome 61、创服模拟器、Android/iOS、完整双指自然操作与真机性能均未通过验收；DOM 事件事实不能替代平台/真机证据。官方文档在线核对与本版隔离结果见 `docs/PREVIEW_PROGRESS.md` §21。
- 核心/UI 接线、停战在途军队/炮击/策反语义、挑战禁外交、认输榜单/挑战码门禁与每局颜色恢复均以冻结源码为准；Senior 已关闭 5 条真实 AI 缺陷，无未关闭阻塞。

以下为 **v1.x 当时快照**，保留原有数字与限制，不代表当前目录或 v2.0.0 状态：

- **v1.2.0 验证状态（隔离副本，代码冻结）**：`typecheck` PASS；`npm test` **665/665 PASS**（0 failed/cancelled/skipped/todo）；`smoke-ui` **475/475 PASS（0 failed / 0 blocked，Node DOM stub，非浏览器；真机 GUI NOT_RUN）**；`build` PASS；`validate` PASS（0 errors / 3 条已知 warning，未放宽）；seeded 108 局 order-balanced **hard 50 / greedy 58 / draw 0**。打包/ZIP/manifest 未生成。
- v1.1.0 历史结果（`fa352cc`）：unit **389/389**、DOM 装配 smoke **394/394**、seeded 108 局 order-balanced **hard 50 / greedy 58 / draw 0**；仅代表 v1.1.0，不是 v1.2 结果。
- v1.0.0 历史结果：unit **291/291**、smoke **329/329**、runtime 237,876 B（SHA-256 `e3320c53…`）；仅历史。
- 端到端 draw：v1.1 的 8 seeds × {idle, play} 未出现，如实记 NOT_FOUND；v1.2 未复验；core 平局 tie-break 由单元测试覆盖。
- 创服模拟器、Android/iOS 真机、Chrome 61 实际运行、原生 FPS、真实相册发布、Web Audio 音效、真实多指同时操作：均 **NOT_RUN**；本地 DOM/Canvas 测试不等于真机。
- 音效：已实现为 Web Audio 离线合成（无音频资源），默认开启、首页设置可关；官方容器是否支持该能力无明确说明，真机音频未验。
- 旧基线 ZIP 永不覆盖；v1.2.0 尚未生成运行时/源码 ZIP。

## 14. v2.0.0 冻结契约与交付口径（2026-11-15）

> 本节是 v2.0.0 冻结源码的规则与隔离口径。第 1–13 节中的 v1.x 数值、默认值和历史测试只属于各自版本；若与本节同名，v2.0.0 以冻结代码和最终 config 为准。外交/盟约与共享通路已按三轮优化重做更新（2026-11-15，以当前源码为准）；00-baseline 备份保留旧「默认全场停战」口径。

- **外交 gate（三轮优化重做后）**：普通 solo 开局无默认停战；玩家在暂停面板提议、接收方 AI 按自身利益接受或拒绝（详见 §8）。每方最多 1 盟友、存活方 ≥3，剩 2 方或盟友淘汰时同 tick 自动解盟；接受盟约 60 秒（600 tick）、拒绝冷却 30 秒（300 tick）；`truces` 唯一事实源并带可选 `lastDecision`。外交使用仅成立或撕毁时 +1、拒绝 +0；`uses > 0` 本局即为 `practice`：不排名、不 mint 可比较的公平码。挑战（包括旧码/练习码）、教学、versus 关闭外交。
- **僵局**：连续 60 秒没有有效进展时只显示预警；连续 120 秒自动结算。有效进展只能由真实占领或真实防守损伤产生；自动结算沿用既有 `score → territory → garrison + in-flight` 顺序，不凭 UI 事件或墙钟假造进展。
- **路径与兵线**：移除断连 source → frontier 的直线 fallback。source、frontier 及玩家/AI 必须使用同一真实连通验证器；不能穿过敌方或中立领地借道，盟约存续时盟友领地可借道并作为攻击前沿（仅中立或共同敌人；兵源仅己方、不控盟兵、不攻盟友）。派出后 `routePoints`、`arrivalTick`、`owner` 冻结，后续版图变化不重算在途路线。解盟/撕毁即时取消指向前盟友与失去合法路线的借道兵线，已经在途的军队不动、按冻结路线走到原定抵达时刻；兵线等待期间真实路径断开仍立即取消。
- **在途军队遇盟约目标**：到达盟约对方（含解盟后的前盟友）目标时只执行一次原地退款：优先退回仍属该军队 owner 的 source；若 source 已失守，则退回 `territoryOrder` 中首个仍属该 owner 的己方领地。落点按容量接收，超出部分丢弃；若已无己方领地，直接移除该 army。该处理不创建返程 army，原有冻结的 `routePoints` / `arrivalTick` 保持到抵达时才处理。
- **局外进度**：每日签到以本地自然日键幂等写入；回拨日期不得再次领取同一日奖励。XP 上限 12 级、连续签到奖励至第 7 天的数值以冻结 `config` 为唯一来源，本规则不复制配置常量，也不把 v1.x 奖励数值借作 v2 事实。缓存等级与 XP 派生等级不一致时按兼容规则修复，不整档判为 `corrupt`。
- **身份与奖励隔离**：每局独立生成/恢复 palette，颜色只影响显示；关注作者只由用户显式点击触发，不绑定金币、XP 或其他奖励；认输计负且不进入本机榜，也不生成可比较挑战码。
- **版本与历史兼容**：`package` 版本 2.0.0；挑战规则版本 2，旧挑战码只读为练习；本机榜 schema 3，记录和分组必须带方数维度；规则版本为 2。旧 v1.x 记录、挑战码、ZIP、manifest 与源码归档保持历史隔离。
- **归档边界**：source 归档按现有脚本自动遍历工作区来源，不要求逐文件登记；本版不新增文档、不改脚本或产物，不以在线页面列出的内测/加白 API、Worker 或平台托管资源扩大游戏契约。

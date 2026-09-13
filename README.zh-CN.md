# CCMultiplayerClient-Next

> [English README](README.md) | 中文版本

[![Discord Server](<https://img.shields.io/discord/382339402338402315.svg?label=Discord%20Server>)](https://discord.gg/SJmMZKy)

一款 [CrossCode](https://www.cross-code.com/)(远星物语)的**在线多人联机模组，Fork自[CCMultiplayerClient](https://github.com/CCDirectLink/CCMultiplayerClient)。
它让多名玩家共享同一个世界:每个人都能看见其他玩家的分身在世界中走动,
而**主机**一方的敌人、弹幕与战斗会通过一台中央中继服务器
([CCMultiplayerServer-Next](https://github.com/LyceenAiro/CCMultiplayerServer-Next))
同步给其余所有玩家。

> **当前状态：初步开发中。** **当前版本 3.0.3**（握手版本号 —— 客户端与服务器必须一致）。
> 主线流程测试进度：法加罗神殿（已完成）。
> 本模组最初面向 CrossCode **1.1.0** 与旧版 **CCLoader v2** 编写。当前代码库**仍基于 CCLoader v2**（目前仍在活跃维护的加载器），
> 但已适配到 **CrossCode 1.4.2**（游戏最终版本）。代码可正常编译，并在真实的 1.4.2 联机会话中游玩测试至法加罗神殿。
> 更后面的主线区域仍由服务器进度墙锁定，尚未完整实测。
>
> **开发说明：** 本项目采用 **vibe coding**（AI 辅助开发）方式开发。

## FAQ

#### 本模组与[cc-multibakery](https://github.com/krypciak/cc-multibakery)有什么区别？

* 本模组专注于剧情、众多支线、共斗的同步，网络开销目前看起开比multibakery要大的多，暂时不支持PVP等功能，但是会比multibakery追求更沉浸的剧情联机体验

#### 我还有多久可以玩到这个CCMultiplayer-fork？

* 现在你就可以开始尝试游玩它，你只需要运行[CCMultiplayerServer-Next](https://github.com/LyceenAiro/CCMultiplayerServer-Next)，之后安装好CCMultiplayerClient-Next，在主界面就可以连接服务器，存档的存储均由服务器负责，你可以在任何一个客户端游玩你的账号

#### Discord板块？

* 很可惜我在Discord群组中并不活跃，我可能会有两三个月才会上线一次Discord，所以该模组应该不会主动披露任何信息到Discord群组中

#### 是否会与cc-multibakery竞争？

* 我将以不绕弯子的方式回答你：如果对方的开发者没有与我主动产生任何矛盾，这是不可能的事情。维护这个模组耗费了我大量的资金（vibe coding导致的）和大量的时间去开发测试，我可能会更希望未来multibakery可以替代这个项目，我不懂任何TypeScrip语法也不熟悉CCLoader的API，如果出现一些奇怪的bug修复起来会非常吃力，相比之下multibakery似乎在任何地方都更精致，网络开销更小，甚至还有看起来非常流畅的PVP模式，我不得不在这里为multibakery做一波宣传

#### 你觉得还有多久才能完成这一个项目？

* 我不清楚，目前我正在与朋友一起游玩，加上自己超高强度的测试与修复，开发经过两个星期测试仍然在神庙矿井的区域中，况且开发者还是一个细节狂魔，有一点看不顺眼的地方就要开始调整

---

## 目录

- [工作原理](#工作原理)
- [功能特性](#功能特性)
- [主城(共享城镇)机制](#主城共享城镇机制)
- [环境要求](#环境要求)
- [构建](#构建)
- [安装](#安装)
- [运行](#运行)
- [配置](#配置)
- [项目结构](#项目结构)
- [网络协议](#网络协议)
- [移植笔记(1.1.0 → 1.4.2,基于 CCLoader v2)](#移植笔记110--142基于-ccloader-v2)
- [已知限制](#已知限制)
- [常见问题排查](#常见问题排查)
- [许可证](#许可证)

---

## 工作原理

CrossCode 是一款单机游戏,因此这里的"多人"实质上是**状态镜像**:

- 在已连接的客户端中,会选出一个**主机(host)**。主机的世界是关于敌人的唯一权威来源。
- 当非主机客户端加载一张地图时,地图数据里的每个 `Enemy` / `EnemySpawner` 实体
  都会在关卡构建前被**剔除**,并用来自主机世界的、由网络驱动的**镜像实体**(puppet)替代。
- 主机会持续广播实体的**位置、动画、状态、目标与生命值**;客户端把这些应用到本地镜像上。
  为了不让本地 AI / 物理与网络数据"打架",镜像实体的 `coll.pos`、`face`、
  `currentAnim`、`currentState` 会被替换成只读访问器,其数值只能由网络来改写。
- 每个远程玩家在本地会被渲染成一个特殊的 `multiplayer` 敌人
  (定义见 [`assets/data/enemies/multiplayer.json`](assets/data/enemies/multiplayer.json)),
  它的 `anims` 使用普通的玩家动画,再用本地玩家的 proxies 重新贴图,使其看起来像一名角色。
- 会话期间主机可以更换(**主机迁移**):若主机掉线,服务器会把另一个客户端提升为新主机,
  实体也会被"解锁"交回本地控制。

通信采用 socket.io 中继:客户端之间从不直接通信,所有数据都经由
`CCMultiplayerServer-Next` 转发。默认使用紧凑线格式（`netSchema` = 标准,可选调试格式）。

## 功能特性

**联机与匹配**

- **服务器列表界面**(Minecraft 风格):新增 / 删除服务器、**直接连接**(host:port)、
  实时**连通性指示器**(在线/离线 + 延迟),无需再手改配置文件。
- **版本校验** —— 服务器会拒绝版本不一致的客户端(当前 **3.0.3**)。
- **账号登录** —— 用户名即身份(LAN 信任);可选密码;重复登录会被拒绝,并记住最近登录的用户名。
- **主城自动匹配** —— 见[主城(共享城镇)机制](#主城共享城镇机制)。
- **进度墙** —— 服务器可通过 `blockedMaps` 列出禁止进入的地图:门口拦截,已在图内的玩家会被送回安全图(默认远星中枢)。当前锁区:`autumn-fall.path-01`。

**世界与战斗同步**

- **全量状态块同步** —— 玩家、主机敌人与敌人弹幕以"全量状态块"广播
  (自愈式,不会因丢包而失同步)。
- **主机选举与迁移** —— 实例中第一个进入的客户端为主机;主机离开时服务器自动迁移。
- **玩家状态** —— 位置 / 朝向 / 动画 / HP / SP / 蓄力 / 过场 / 元素 / 战斗职业 / 防御时机。
- **敌人同步** —— 主机权威,双频率(基础流 + 选项驱动的敌对流),
  外加敌人音效 / 攻击 / 掉落 / AR 信息 / 特效。
- **地牢机关同步** —— 推拉箱子、滑动方块、浮空踏板、开关、冰柱等谜题实体通过
  紧凑 `puzzleState` 中继 + 主机快照同步;抓箱归属主机权威并按帧插值;
  已放置箱子属个人存档进度。
- **任务击杀进度同步** —— **剧情同步**中任意队员击杀会计入全队;未开启时仅同地图计数。
- **剧情同步** —— 主线 / 支线队伍级进度,队长权威流、聚齐触发过场、跳过投票。
- **Boss 交接** —— 主机转发 Boss 阶段与脚本击杀过场,客机与主机演出保持同步。
- **交易** —— 玩家间交易,服务器侧比率与导入存档/镜像回溯后的防刷锁定。
- **软死亡复活** —— 战斗中倒地后可按倒计时复活(HP 比例与时间可由服务器配置;Boss 战更严)。
- **战斗反馈** —— 敌人受击、格挡与完美格挡(客机带 ping 补偿)、反击/破防特效、技能音效/特效重放、全队蓄力时停。
- **死亡与复活** —— 倒地玩家进入观战;全队阵亡时一起读取最近存档点保持同步。
- **客机加固** —— 临时剧情同伴、梦境特效清理、过场脱卡、技能守卫等。

**社交与组队**

- **组队** —— 邀请 / 接受 / 拒绝 / 退出 / 踢出、队长转移、以及"传送到队友身边"归队。
- **好友** —— 申请 / 接受 / 拒绝 / 删除、申请管理、名字搜索;
  官方同伴可重新添加为好友(自动接受)。
- **队伍 bot** —— 队长的随从 bot 会镜像给队员;离线好友可作为 "mod bot" 跟随。
  在地牢中会按原版规则清除所有网络 bot,离开地牢后自动恢复。
- **剧情锁定同伴** —— 同伴只在游戏自身 `SET_MEMBER_LOCKED` 标志开启时不可踢出。
- **房间玩家** —— 查看当前地图实例中有谁,另有实时在线人数。
- **小队聊天** —— 回车打开聊天输入框,带历史记录与气泡渲染(仅限队伍)。

**HUD 与辅助**

- **名字标签** —— 显示名字 / 自己名字 / bot 名字、队长金色名字、ping 值显示、
  可调透明度与字号。
- **网络徽章** —— 队伍头像与元素指示器上的绿/黄/橙/红菱形(延迟/丢包),带悬停提示。
- **网络调试 HUD** —— 实时上行/下行速率、丢包率、累计流量。
- **模组设置页** —— 游戏菜单里新增的"多人"选项卡,含**外部 UI 缩放**与线格式偏好。
- **快速菜单(SHIFT)查看** —— 可查看在线玩家与队伍 bot,带添加/删除好友按钮。
- **直接保存+上传** —— 联机时背包菜单 / ESC 菜单的保存按钮会直接存档并上传。
- **屏幕外队友箭头** 与区域/世界地图队友头像。
- **队友使用物品 / 治疗指示**。

**存档与持久化**

- **云端存档** —— 登录时从服务器流式下载并恢复存档;保存与退出前会分块限速上传。
- **存档镜像回溯** —— 服务器为每名玩家保留最近 **5 份不重复的存档镜像**。
  登录界面的 **镜像回溯** 按钮会先登录并暂扣最新存档流,展示带时间戳的 5 份镜像,
  选择任意一份即可进入(可用 **×** 关闭)。
- **防刷** —— 区域存档节流、登录时的上传抑制窗口。
- **本地持久化** —— 服务器列表、选项、登录历史、聊天历史在重启后保留(localStorage)。

## 主城(共享城镇)机制

六个大区域被设为**主城**(开放匹配的汇合点),玩家无需组队即可在此相遇:

- **新手港**(`rookie-harbor`, Rookie Harbor)
- **罗姆斯广场**(`rhombus-sqr`, Rhombus Square,含迎新桥)
- **俾尔根村**(`bergen`, Bergen Village)
- **巴基库姆**(`ba-ki-kum`, Ba'kii Kum)
- **巴辛堡**(`basin-keep`, Basin Keep)
- **家园**(`homestedt`, Homestedt)

行为规则:

- **按大区域划分实例。** 整个大区域算作一个主城实例 —— 只要处于该区域,
  无论站在哪张子地图,都会自动匹配进同一个实例(`town:<area>[#N]`),
  而不是按子地图各自分房。
- **主机同野外。** 与野外一致,第一个进入某条分线的玩家成为该分线主机,
  主机迁移逻辑不变。
- **无需组队。** 自动与已在主城中的玩家匹配。
- **每条分线最多 32 人。** 满员后新进入者自动进入新的 `town:<area>#N` 分线。
- **为多人大厅优化了网络。** 为了让 32 人房间保持轻量:
  - 玩家状态(HP / 经验 / SP 等)以 **1 Hz** 同步;
  - 位置以 **10 Hz** 同步;
  - **不发送**敌人 / 弹幕相关的同步包(主城没有敌人);
  - **不同步**队伍 bot —— bot 仅其队长自己可见;
  - 幽灵宝箱仍然**仅限组队**。

## 环境要求

| 组件 | 版本 |
| --- | --- |
| CrossCode | **1.4.2**(最终版本,官方已不再更新) |
| Mod 加载器 | **CCLoader v2** —— 它自带本模组所用的 `simplify` 库 |
| Node.js(构建) | ≥ 18 |
| 中继服务器 | [CCMultiplayerServer-Next](https://github.com/LyceenAiro/CCMultiplayerServer-Next) **3.0.3**(Node ≥ 14) |

## 构建

```bash
npm install
npm run build
```

构建会生成 `dist/` 目录:

```
dist/
├─ mod.js       # 模组本体,打包成单个传统脚本(CCLoader v2 的 `main` 阶段执行)
└─ mod.js.map
```

游戏资源与默认服务器列表**不会**复制进 `dist/`,CCLoader v2 会直接从模组目录加载:

```
assets/
├─ data/enemies/multiplayer.json          # 镜像玩家敌人类型
└─ media/sound/storysync/*.ogg            # 剧情同步音效
config/config.json                        # 默认服务器列表
```

常用脚本:

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 通过 esbuild 做一次生产环境打包 |
| `npm run watch` | 监听文件变化并自动重新构建 |
| `npm run check` | 仅做类型检查(`tsc --noEmit`),基于 1.4.0 类型定义 |

## 安装

1. 在你的 CrossCode 1.4.2 中安装 **CCLoader v2**
   (参见 [CCLoader 仓库](https://github.com/CCDirectLink/CCLoader))。
   它自带本模组所依赖的 `simplify` 库模组。
2. 把本模组文件夹复制到游戏的 `assets/mods/` 目录,使模组的 `package.json`
   位于 `assets/mods/multiplayer/`,并把编译好的 `dist/` 放在它旁边。
3. 清单中的 `main` 已指向打包产物(`"main": "dist/mod.js"`),且 `ccmodDependencies`
   已声明 `simplify`,加载器会自动装配好一切。

## 运行

1. 启动一台中继服务器(见服务端仓库),例如:
   ```bash
   cd CCMultiplayerServer-Next
   npm install
   npm start          # 默认监听 *:15151
   ```
2. 把服务器地址加入 `config/config.json`(或直接使用自带的默认配置)。
3. 通过 CCLoader v2 启动游戏。在**标题界面**,第二个菜单按钮会被改写成
   **Connect(连接)** —— 点击它,选择一台服务器,输入用户名,
   模组就会把你载入主机当前所在的地图。

## 配置

`config/config.json` 列出了游戏内服务器选择器中显示的服务器:

```json
{
	"servers": [
		{ "hostname": "localhost", "port": 15151, "type": "http" },
		{ "display": "公共服务器", "hostname": "example.com", "port": 15151, "type": "http" }
	]
}
```

- `hostname` / `port` / `type` —— socket.io 中继服务器的位置(`type` 为 URL 协议,`http` 或 `https`)。
- `display` —— 可选,在服务器选择器中显示的友好名称。
- 界面里新增服务器时的默认端口为 **15151**。

服务器侧玩法参数(怪物缩放、交易、挂机、进度墙、管理页等)在**服务端** `config.json` 中,见服务器 README。

## 项目结构

```
src/
├─ main.ts                     # CCLoader v2 入口(`main` 阶段,等待 modsLoaded 事件)
├─ multiplayer.ts              # 总协调器:连接、界面劫持、实体注册表、版本号
├─ config.ts / configFile.ts   # 服务器列表配置加载
├─ connection.ts               # IConnection 接口(网络协议面)
├─ connectors/SocketIOConnector.ts  # IConnection 的 socket.io 实现
├─ simplify.d.ts               # CCLoader v2 自带 Simplify 库的类型声明
├─ loadScreenHook.ts           # 旧:复用"读取存档"菜单(现为 ui/serverList.ts)
├─ types.d.ts                  # 共享的 Vec2/Vec3 结构
├─ i18n.ts                     # UI 文案(en / zh-CN / zh-TW 等)
├─ mpEntity.ts / player.ts / server.ts / ballInfo.ts / entityDefinition.ts
├─ models/identifyResult.ts
├─ util/areaUtil.ts            # 区域 path / type / 解锁辅助
├─ listeners/
│  ├─ game/                    # 监听本地游戏状态 → 广播变更
│  │  ├─ entityListener.ts  playerListener.ts
│  │  ├─ onPlayerMove/Animation/HealthChange.ts
│  │  ├─ onEntityMove/Animation/HealthChange/StateChange/TargetChange.ts
│  │  ├─ onEntitySpawn.ts onKill.ts
│  │  └─ onMapEnter.ts onMapLoaded.ts onTeleport.ts
│  └─ connection/              # 把远端状态 → 应用到本地世界
│     ├─ onSetHost.ts onPlayerChangeMap.ts onRegisterEntity.ts onKillEntity.ts
│     ├─ onThrowBall.ts onUpdatePosition/Animation/AnimationTimer.ts
│     └─ onUpdateEntity{Position,Animation,State,Target,Health}.ts
├─ sync/                       # 高层联机系统
│  ├─ netSync.ts               # 主机敌人流、puppet、战斗中继
│  ├─ storySync.ts             # 剧情 / 任务同步
│  ├─ puzzleSync.ts            # 地牢谜题实体
│  ├─ cutsceneRelay.ts         # 聚齐触发剧情
│  ├─ cutsceneActorGuard.ts    # 缺失剧情演员 + 脱卡
│  ├─ tempPartyBot.ts          # 临时剧情同伴
│  ├─ dreamFxGuard.ts          # 梦境特效 / 晃动清理
│  ├─ tradeSync.ts             # 玩家交易
│  ├─ bubbleSync.ts / ghostChests.ts / skillGuard.ts / saveUploadQueue.ts
│  └─ wireSchema.ts / pvpIsolation.ts
└─ ui/                         # DOM / 游戏内界面
   ├─ serverList.ts  mpOptions.ts  chatBox.ts  socialMenuInject.ts
   ├─ socialOverlay.ts  quickMenuInject.ts  netBadge.ts  uiScale.ts
   ├─ teammateIndicators.ts  mapTeamAvatars.ts  itemUseIndicator.ts
   ├─ healSync.ts  aimLineIndicators.ts  saveButtons.ts  toasts.ts
   └─ unstuckButton.ts  versionDisplay.ts  deathLineHud.ts  shopDiag.ts
```

## 网络协议

使用普通的 socket.io 事件。客户端→服务器与服务器→客户端使用相同的事件名;
由服务器转发给同地图的相关成员。握手流程:

```
客户端 → 服务器  "handshake"          { username, password?, version, client }
服务器 → 客户端  "handshakeResponse"  { success, host, username, mapName, …调参 }
```

`handshakeResponse` 还会带上服务器玩法调参(怪物 HP/攻防缩放、软死亡复活、交易规则、
转发频率上限、`blockedMaps` 等)。握手后存档以 `saveDownload` 分块流式下发。

高层事件分组(非完整列表,线上协议较宽):

| 分组 | 示例 | 说明 |
| --- | --- | --- |
| 会话 | `changeMap` / `onPlayerChangeMap`, `setHost`, `logout` | 成员关系与主机迁移 |
| 分身 | `updatePosition`, `updateAnimation`, `playerState` | "我自己"的分身与紧凑玩家块 |
| 敌人 | `entityState`, `registerEntity` / `killEntity`, `enemyAttack`, `enemySound`, `enemyFx` | 主机权威 |
| 战斗 | `throwBall`, `combatHit`, `combatResult`, `latePerfectGuard`, `skillFx` | 命中、格挡、技能 |
| 地牢 | `puzzleState`, `elevatorSync`, `bombState` / `bombHandoff`, `bubbleState` | 谜题实体 |
| 剧情 | `cutsceneTrigger`, `cutsceneEntity`, `bossPhase`, `bossDefeat`, `questKill`, `spawnVar` | 剧情 / Boss / 任务 |
| 社交 | `party*`, `friend*`, `trade*` | 组队、好友、交易 |
| 存档 | `saveChunk`, `saveDownload`, `saveMirrorRestore` | 云端存档与镜像回溯 |
| 其它 | `mpPing` / `netPing`, `netSchemaPref`, 管理确认 | 延迟、线格式、管理 |

## 移植笔记(1.1.0 → 1.4.2,基于 CCLoader v2)

这一节是"适配到最新版本"的实质内容。模组**仍基于 CCLoader v2**,并继续使用其自带的
**Simplify** 库,因此加载机制与大部分管线保持不变。真正的工作是
**让代码适配 1.1.0 → 1.4.2 的游戏变化**,并对构建做了现代化。

**加载机制(不变 —— CCLoader v2)**

- 仍是经清单的 `main` 阶段加载的传统脚本,依赖全局 `modsLoaded` DOM 事件启动,
  并用 `ccmodDependencies` 声明运行时依赖(`ccloader`、`crosscode`、`simplify`)。
  同时保留了一份与 npm 同步的 `package.json` 清单。

**构建工具(现代化)**

- webpack → **esbuild**,输出单个传统(IIFE)脚本 `dist/mod.js`,由 v2 直接执行。
  运行时仍通过 `simplify.loadScript` 从中继服务器拉取匹配的 socket.io 客户端库;
  npm 包主要用于 TypeScript 类型。
- 手写的 `src/@types/*` →
  [`ultimate-crosscode-typedefs`](https://github.com/CCDirectLink/ultimate-crosscode-typedefs)
  (CrossCode 1.4.0),vendor 在 `vendor/` 目录;另加了一份本地的
  `src/simplify.d.ts` 用于声明 Simplify 全局对象。

**1.1→1.4 的类型/API 收紧修复**

- `IMultiplayerEntity` 不再放宽 `Enemy.target`(1.4 中为 `sc.BasicCombatant`),改用交叉类型。
- `player.currentAnim` 现在可能是动画集合对象 → 归一化为动画名。
- `loadLevel`/`teleport` 改经具体的 `sc.CrossCode` 类型绑定。
- `MapData` → `sc.MapModel.Map`;地图实体的 `settings` 以宽松方式读取。
- 由网络驱动的 action/event-step 载荷(`SHOOT_PROXY`、`DO_ACTION`、`spawnEntity` 的 `skipHook`)
  采用类型断言,因为这些内部结构随版本漂移,且属于模组自有协议。

**顺带修复的 bug**

- `onEntityStateChange` 之前误存了浏览器全局 `window.status` 而非实体状态
  (`this.last = status`),导致实体状态更新每帧都触发。现已改为存储真实状态。

**服务端**

- 与游戏版本无关的 socket.io 中继,但在 Next 版大幅扩展(账号、云端存档与镜像、
  组队、好友、交易、管理页、进度墙、频率上限)。需与客户端 **3.0.3** 配套。

## 已知限制

- **标题界面按钮劫持。** `initializeGUI()` 按*固定下标*改写标题界面按钮
  (依平台为 `buttons[1]` 或 `[2]`)。若布局已变化,会告警而不是崩溃。
- **更后面的主线区域。** 当前进度墙(`autumn-fall.path-01` 及之后)尚未完整实测。
- **DLC / 二周目内容。** 1.1.0 之后新增的敌人类型与地图走同一套通用同步机制,可能仍需微调。
- `ig.game.teleport` / `spawnEntity` 是通过直接赋值来包裹的;若其他模组也这样做可能冲突。
- 游戏内 F8 调试命令框**对玩家已关闭**(仅测试用,误用可能弄脏服务器状态)。

如果你要在真实环境测试,浏览器控制台(`[multiplayer] …` 日志)是第一排查入口。

## 常见问题排查

- **"Could not locate the title-screen button to hijack"** —— 标题界面布局不同;
  调整 `multiplayer.ts` 中的 `buttonNumber`。
- **服务器选择器里没有服务器** —— `config/config.json` 不存在;补一份或重装模组。
- **"Could not login"** —— 该用户名已连接、密码错误,或账号被锁定。
- **版本不一致** —— 客户端与服务器都必须是 **3.0.3**。
- **CCLoader v2 中本模组不显示 / 不加载** —— 确认清单的 `main` 指向 `dist/mod.js`、
  该文件已确实构建,且 `simplify` 模组已安装并启用(它列在 `ccmodDependencies` 里)。
- **"Could not find our own mod via simplify.getMod()"** —— 模组文件夹需被识别为
  `multiplayer`(即清单中的 `name`),这正是 Simplify 查找所用的名字。

## 许可证

本项目采用 MIT 许可证 —— 详见 [LICENSE](LICENSE) 文件。

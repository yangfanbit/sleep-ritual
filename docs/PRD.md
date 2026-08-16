# Sleep Ritual — PRD

> 版本：MVP v1（整理自 2026-08-16 项目初始化需求）
> 状态：第一阶段开发中

## 1. 产品定位

**睡前行为干预器**，运行在 iPhone 上的个人 PWA。

目标：减少主动熬夜行为。它不是睡眠记录 App，不关心睡得怎么样，只干预"睡之前那半个小时"。

### 核心流程：Anchor → Buffer → Transition

| 阶段 | 动作 |
| --- | --- |
| Anchor | 到达设定睡前时间，iPhone Shortcut 自动打开 Sleep Ritual |
| Buffer | 不说"赶快睡"，先问"我为什么现在还不想睡"，帮助用户理解自己 |
| Transition | 极低成本的行为替代 → 微行为 → 进入 SleepTown |

职责边界：

- **Sleep Ritual**：心理和行为干预
- **SleepTown**：睡眠执行与闹钟（通过 URL Scheme 衔接，`sleeptown://` 未经验证，必须有备用按钮兜底）

### 项目边界

- 完全独立于个人博客（yfnwu.com，Gridea Pro 部署）
- 不读、不改、不依赖博客任何代码与部署
- 未来独立部署到 `https://sleep.yfnwu.com/`

## 2. 核心设计原则（不可违反）

1. 用户在页面停留时间越短越好，理想单次 30 秒 ~ 2 分钟
2. 不做无限滚动
3. 不做内容消费流
4. 不做复杂日记
5. 不用羞辱式反馈
6. 不使用「失败」「断签」「重新开始」等设计
7. 不让用户因本 App 继续刷手机
8. 夜间界面尽量减少视觉刺激
9. 金句/文章只是干预入口，不是产品核心
10. 产品核心：为什么不睡 → 理解 → 缓冲 → 微行为 → 离开手机

## 3. MVP 功能范围

### 3.1 夜间闭环

打开 → 显示一句随机内容 → 选择为什么不想睡（最多 2 项）→ 必要时 Brain Dump → 获得一个微行为提示 → 写一句给明天的自己 → 开始睡觉 → 尝试打开 SleepTown

#### 原因选项（最多选 2）

- 今天还不想结束
- 想继续刷手机
- 白天属于自己的时间太少
- 工作 / 学习没完成
- 情绪不好
- 不想面对明天
- 想把这个内容看完
- 就是不困
- 其他

#### Brain Dump

- 提示「脑子里还有什么？」，随意输入
- 点「丢掉」：**不保存**，清空文本，轻微淡出反馈
- 与 Tonight Message（保存）严格区分

#### 行为替代（简单规则，不调 AI）

| 原因 | 微行为 |
| --- | --- |
| 想继续刷手机 | 先把手机放远 1 米 |
| 今天还不想结束 | 写一句：今天已经完成了什么？ |
| 不想面对明天 | 写下明天最担心的一件事 |
| 工作没完成 | 写下明天第一件要做的事 |
| 情绪不好 | 先把脑子里的东西写下来，然后丢掉 |
| 其余选项 | 预定义提示，见 `js/content.js` `BEHAVIOR_TIPS` |

#### Tonight Message

「今晚，我想对明天的自己说……」，保存，早晨展示。

#### 开始睡觉

1. 保存 NightSession
2. 记录当前时间
3. 尝试打开 `sleeptown://`
4. 若不可用，显示明显的「打开 SleepTown」备用按钮
5. SleepTown Scheme 不可用不得导致 App 失效

### 3.2 早晨闭环

显示：早安 / 昨晚放下手机时间 / 昨晚写给自己的话

然后：

- 简单状态三选一：🙂 精神不错 / 😐 一般 / 😴 很困
- 「今天的我想说……」一句话
- 保存（MorningSession）

### 3.3 History

最近 7 ~ 30 天简单列表：日期、目标睡觉时间、实际睡觉时间、拖延时间、熬夜原因、Tonight Message、Morning Message。不做复杂图表，允许极简趋势。

### 3.4 Settings

- 目标睡觉时间
- 目标起床时间
- 内容管理（增删）
- JSON 导出
- JSON 导入
- 数据清空

### 3.5 Content

类型：`quote` / `excerpt`（文章摘录）/ `image` / `url` / `self` / `tip`（行为提示）

- Settings 中可管理
- Night Mode **不展示内容库**，每晚只随机一条
- v1 实现 quote / excerpt / self / tip 四种文本类型；image / url 类型预留

## 4. 数据模型（IndexedDB）

DB：`sleep-ritual`，v1

| Store | keyPath | 索引 | 说明 |
| --- | --- | --- | --- |
| `settings` | `key` | — | 用户设置 |
| `content` | `id` (auto) | — | 内容库 |
| `nightSessions` | `id` (auto) | `date` | 每晚记录 |
| `morningSessions` | `id` (auto) | `date` | 早晨记录 |

### settings

```json
{ "key": "bedtime", "value": "23:30" }
{ "key": "waketime", "value": "07:30" }
```

### content

```json
{
  "id": 1,
  "type": "quote | excerpt | self | tip",
  "text": "……",
  "source": "可选来源",
  "createdAt": "ISO 8601"
}
```

### nightSessions

```json
{
  "id": 1,
  "date": "2026-08-16",
  "bedTimeTarget": "23:30",
  "shownAt": null,
  "actualSleepAt": "2026-08-16T23:41:22.000Z",
  "contentId": null,
  "reasons": ["keep_scrolling", "not_over"],
  "behaviorTip": "先把手机放远 1 米，够不到就行。",
  "tonightMessage": "一句话"
}
```

### morningSessions

```json
{
  "id": 1,
  "date": "2026-08-17",
  "mood": "good | ok | sleepy",
  "morningMessage": "一句话",
  "createdAt": "ISO 8601"
}
```

字段允许向后扩展。

## 5. 技术与非功能要求

- 纯 HTML / CSS / Vanilla JS，无框架、无构建
- PWA：`manifest.webmanifest` + `sw.js`
  - standalone、iPhone safe area、深色模式（Night 深色）、离线打开、首页秒开
- 无后端、无登录、无数据库服务器、无云同步
- JSON 导出 / 导入
- 可部署 GitHub Pages
- 尽量轻量

## 6. 视觉方向

**Night Mode**：深黑/深灰、大留白、柔和灰文字、非刺眼、少动画、低信息密度。

**Morning Mode**：更明亮、简洁、温和、轻微正反馈。

不要：科技 Dashboard、普通睡眠 App 风、复杂卡片墙。

## 7. 非目标（v1 不做）

- 统计图表与趋势分析
- 连续打卡 / 成就系统
- AI 生成内容或 AI 对话
- 多设备同步、账号系统
- 睡眠时长 / 睡眠质量分析
- 通知推送
- Shortcut 自动化配置教程（后续再补）

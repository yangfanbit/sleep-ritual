/* ============================================================
   Sleep Ritual — 静态内容定义
   - 熬夜原因选项
   - 原因 → 行为替代提示（简单规则，不调用 AI）
   - 初始内容库种子（首次启动写入 IndexedDB）
   ============================================================ */

const REASONS = [
  { id: "not_over",        label: "今天还不想结束" },
  { id: "keep_scrolling",  label: "想继续刷手机" },
  { id: "no_me_time",      label: "白天属于自己的时间太少" },
  { id: "work_unfinished", label: "工作 / 学习没完成" },
  { id: "bad_mood",        label: "情绪不好" },
  { id: "fear_tomorrow",   label: "不想面对明天" },
  { id: "finish_content",  label: "想把这个内容看完" },
  { id: "not_sleepy",      label: "就是不困" },
  { id: "other",           label: "其他" },
];

/* 每个原因对应的低成本行为替代。规则写死，第一版不做个性化。 */
const BEHAVIOR_TIPS = {
  not_over:        "写一句：今天已经完成了什么？写完就算今天结束了。",
  keep_scrolling:  "先把手机放远 1 米，够不到就行。",
  no_me_time:      "允许自己明天留 15 分钟，只做想做的事。现在先欠着，记账。",
  work_unfinished: "写下明天第一件要做的事。写下来，它就不用在你脑子里过夜。",
  bad_mood:        "先把脑子里的东西写下来，然后丢掉。情绪不用解决，先放下来。",
  fear_tomorrow:   "写下明天最担心的一件事。担心写完，今天就归今天。",
  finish_content:  "把它收藏，设成明天早晨的第一条。它跑不掉。",
  not_sleepy:      "不困也没关系。关灯躺下，允许自己只是休息。",
  other:           "不需要理由。把手机放下，就是今晚最后一件事。",
};

/* 首次启动时写入内容库的种子数据 */
const SEED_CONTENT = [
  {
    type: "quote",
    text: "今天结束的方式，决定了明天开始的方式。",
    source: "",
  },
  {
    type: "quote",
    text: "你不是舍不得睡，是舍不得这一天。承认这一点，然后让它过去。",
    source: "",
  },
  {
    type: "self",
    text: "明天的你会感谢现在就放下手机的自己。",
    source: "写给自己的话",
  },
  {
    type: "excerpt",
    text: "熬夜常常不是因为不困，而是因为白天没有属于自己的时间，夜里想补回来。这叫报复性熬夜。补不回来的，只会让明天更缺。",
    source: "",
  },
  {
    type: "tip",
    text: "把手机充到够不着的地方，比任何意志力都可靠。",
    source: "",
  },
];

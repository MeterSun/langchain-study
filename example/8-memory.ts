import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import { Agent } from "../src/core/agent.ts";
import { WindowMemory, SummaryMemory, saveMemory, loadMemory } from "../src/core/memory.ts";

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL!,
  apiKey: process.env.OPENAI_API_KEY!,
});
const llm = new OpenAIModel(client, "deepseek-v4-flash");

// ─── 1. WindowMemory：滑动窗口 ─────────────────────────────────
console.log("=== 1. WindowMemory ===");

const windowAgent = new Agent({
  llm,
  systemPrompt: "你是对话助手。",
  memory: new WindowMemory(4), // 只保留最近 4 条非 system 消息
});

// 模拟多轮对话
const topics = ["苹果", "香蕉", "橙子", "葡萄", "西瓜"];
for (const fruit of topics) {
  await windowAgent.run(`我喜欢吃${fruit}，请用一句话回应。`);
}

const state = windowAgent.getState();
console.log("存储的消息数（getAll）:", state.messages.length);
console.log(
  "发给 LLM 的消息数（getMessages）:",
  (await windowAgent.memory.getMessages()).length,
);
console.log(
  "是否记得第一条（苹果）:",
  state.messages.some((m) => m.content.includes("苹果")),
);
console.log(
  "LLM 是否能看到苹果:",
  (await windowAgent.memory.getMessages()).some((m) =>
    m.content.includes("苹果"),
  ),
);
console.log(
  "LLM 是否能看到西瓜:",
  (await windowAgent.memory.getMessages()).some((m) =>
    m.content.includes("西瓜"),
  ),
);

// ─── 2. SummaryMemory：LLM 摘要压缩 ────────────────────────────
console.log("\n=== 2. SummaryMemory ===");

const summaryMemory = new SummaryMemory(llm, { maxMessages: 4, summarizeCount: 4 }); // 超过 4 条时摘要 4 条
const summaryAgent = new Agent({
  llm,
  systemPrompt: "你是对话助手。",
  memory: summaryMemory,
});

// 多轮对话触发摘要
const foods = [
  "北京烤鸭",
  "上海小笼包",
  "广州早茶",
  "成都火锅",
  "西安肉夹馍",
  "重庆小面",
];
for (const food of foods) {
  await summaryAgent.run(`我吃了${food}，请用一句话回应。`);
  console.log(
    `  [${food}] 摘要: ${(summaryMemory.getSummary() ?? "(无)").slice(0, 80)}...`,
  );
}

console.log("\n最终摘要:", summaryMemory.getSummary());
console.log("存储的消息数:", summaryMemory.getAll().length);
console.log("当前消息:", await summaryMemory.getMessages());

// 摘要后 LLM 是否还记得之前的内容
const recall = await summaryAgent.run("我之前提到了哪些城市？按顺序列出。");
console.log("回忆测试:", recall);

// ─── 3. 持久化：保存到文件 + 重新加载 ──────────────────────────
console.log("\n=== 3. 持久化 ===");

const persistMemory = new WindowMemory();
const persistAgent = new Agent({
  llm,
  systemPrompt: "你是对话助手。",
  memory: persistMemory,
});

await persistAgent.run("我叫张三，今年28岁。");
await persistAgent.run("我住在北京。");

// 保存
await saveMemory(persistMemory, "/tmp/agent-memory.json");
console.log("已保存到 /tmp/agent-memory.json");

// 新建 Agent，加载历史
const restoredMemory = new WindowMemory();
await loadMemory(restoredMemory, "/tmp/agent-memory.json");
const restoredAgent = new Agent({
  llm,
  memory: restoredMemory,
});

console.log("加载的消息数:", restoredMemory.getAll().length);

// 验证记忆是否完整
const answer = await restoredAgent.run("我叫什么名字？");
console.log("恢复后回答:", answer);

import { z } from "zod";
import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import { Agent } from "../src/core/agent.ts";
import { defineTool } from "../src/core/tool.ts";
import type { AgentStepEvent } from "../src/core/type";

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL!,
  apiKey: process.env.OPENAI_API_KEY!,
});

const llm = new OpenAIModel(client, "deepseek-v4-flash");

const getWeather = defineTool({
  name: "get_weather",
  description: "获取指定城市的当前天气",
  parameters: z.object({
    city: z.string().describe("城市名，例如：北京"),
  }),
  execute: async ({ city }) => {
    const data: Record<string, string> = {
      北京: "晴，25°C，湿度 40%",
      上海: "多云，28°C，湿度 65%",
      广州: "雷阵雨，30°C，湿度 85%",
    };
    return data[city] ?? `未知城市：${city}`;
  },
});

// ─── 1. onStep 回调观察每一步 ──────────────────────────────────
const steps: AgentStepEvent[] = [];

const agent = new Agent({
  llm,
  tools: [getWeather],
  systemPrompt: "你是天气助手。需要查天气时调用 get_weather 工具。",
  onStep: (e) => steps.push(e),
});

console.log("=== 1. Step 事件 ===");
const answer1 = await agent.run("北京天气怎么样？");
console.log("最终回答:", answer1);
console.log("步骤数:", steps.length);
for (const s of steps) {
  console.log(
    `  [iter ${s.iteration}] ${s.type}: ${s.message.substring(0, 60)}${s.message.length > 60 ? "..." : ""}`,
  );
}

// ─── 2. History 累积：多轮对话 ─────────────────────────────────
console.log("\n=== 2. 多轮对话（History 累积）===");
console.log("第 1 轮后 messages 数:", agent.getState().messages.length);

const answer2 = await agent.run("那上海呢？");
console.log("第 2 轮回答:", answer2);
console.log("第 2 轮后 messages 数:", agent.getState().messages.length);

const answer3 = await agent.run("帮我比较一下两地");
console.log("第 3 轮回答:", answer3);
console.log("第 3 轮后 messages 数:", agent.getState().messages.length);

// ─── 3. reset() 清空历史 ────────────────────────────────────────
console.log("\n=== 3. reset() 清空 ===");
agent.reset();
console.log("reset 后 messages 数:", agent.getState().messages.length);

const answer4 = await agent.run("我刚才问了什么？");
console.log("reset 后再问:", answer4);
console.log("（应该说不记得之前的对话，因为历史已清空）");

// ─── 4. getState() 查看完整状态 ─────────────────────────────────
console.log("\n=== 4. State 快照 ===");
const state = agent.getState();
console.log("iteration:", state.iteration);
console.log("messages 数:", state.messages.length);
console.log("lastStep:", state.lastStep?.type);

import { z } from "zod";
import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import { Agent } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/core/registry.ts";
import { defineTool } from "../src/core/tool.ts";
import { calculator } from "../src/tools/calculator.ts";
import { httpGet } from "../src/tools/http.ts";

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL!,
  apiKey: process.env.OPENAI_API_KEY!,
});
const llm = new OpenAIModel(client, "deepseek-v4-flash");

// ─── 1. Registry 注册/搜索/调用 ────────────────────────────────
const registry = new ToolRegistry()
  .register(calculator)
  .register(httpGet)
  .register(
    defineTool({
      name: "get_weather",
      description: "获取指定城市的当前天气",
      parameters: z.object({ city: z.string() }),
      metadata: { category: "weather", tags: ["forecast"], version: "1.0.0" },
      execute: async ({ city }) => {
        const data: Record<string, string> = {
          北京: "晴，25°C",
          上海: "多云，28°C",
        };
        return data[city] ?? `未知城市：${city}`;
      },
    }),
  );

console.log("=== 1. Registry ===");
console.log(
  "已注册:",
  registry.list().map((t) => t.name),
);

// 按 category 搜索
const mathTools = registry.search({ category: "math" });
console.log(
  "math 类:",
  mathTools.map((t) => t.name),
);

// 按 tag 搜索
const networkTools = registry.search({ tag: "http" });
console.log(
  "http tag:",
  networkTools.map((t) => t.name),
);

// 模糊搜索
const weatherTools = registry.search({ nameContains: "weather" });
console.log(
  "name 含 weather:",
  weatherTools.map((t) => t.name),
);

// 直接 invoke（带 timeout/retry）
console.log("\n=== 2. invoke（timeout + retry）===");
const calcResult = await registry.invoke("calculator", { expression: "1+2*3" });
console.log("calculator 1+2*3 =", calcResult);

// 测试 timeout（构造一个会超时的工具）
const slowTool = defineTool({
  name: "slow_tool",
  description: "模拟慢工具",
  parameters: z.object({}),
  execute: async () => {
    await new Promise((r) => setTimeout(r, 3000));
    return "done";
  },
});
registry.register(slowTool);
try {
  await registry.invoke("slow_tool", {}, { timeoutMs: 500 });
} catch (e) {
  console.log("timeout 测试:", e instanceof Error ? e.message : String(e));
}

// 测试 retry（构造一个会重试成功的工具）
let attempts = 0;
const flakyTool = defineTool({
  name: "flaky_tool",
  description: "前两次失败，第三次成功",
  parameters: z.object({}),
  execute: async () => {
    attempts++;
    if (attempts < 3) throw new Error(`attempt ${attempts} failed`);
    return `succeeded on attempt ${attempts}`;
  },
});
registry.register(flakyTool);
const retryResult = await registry.invoke(
  "flaky_tool",
  {},
  { retries: 3, retryDelayMs: 100 },
);
console.log("retry 测试:", retryResult);

// ─── 3. Agent 集成 Registry ────────────────────────────────────
console.log("\n=== 3. Agent + Registry ===");
const agent = new Agent({
  llm,
  registry,
  systemPrompt:
    // "你是助手。需要计算时用 calculator 工具，需要查天气时用 get_weather 工具。",
    "你是助手",
  toolInvokeOptions: { timeoutMs: 15_000, retries: 1 },
});

const answer = await agent.run("(12 + 8) * 3 等于多少？");
console.log("Agent 回答:", answer);

// ─── 4. 内置 http_get 工具实战 ─────────────────────────────────
console.log("\n=== 4. http_get 实战 ===");
const httpResult = await registry.invoke("http_get", {
  url: "https://httpbin.org/json",
});
console.log("httpbin 响应（前 200 字）:", httpResult.slice(0, 200));

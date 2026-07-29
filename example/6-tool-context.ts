import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import { Agent } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/core/registry.ts";
import { todoList } from "../src/tools/todo.ts";

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL!,
  apiKey: process.env.OPENAI_API_KEY!,
});
const llm = new OpenAIModel(client, "deepseek-v4-flash");

// ─── 1. 手动测试 context 隔离 ──────────────────────────────────
console.log("=== 1. 两个 Agent 的 context 互相隔离 ===");

const registry1 = new ToolRegistry().register(todoList);
const registry2 = new ToolRegistry().register(todoList);

const agent1 = new Agent({ llm, registry: registry1 });
const agent2 = new Agent({ llm, registry: registry2 });

// agent1 加两个任务
await agent1.registry.invoke("todo_list", { action: "add", content: "写文档" }, undefined, agent1.context);
await agent1.registry.invoke("todo_list", { action: "add", content: "发邮件" }, undefined, agent1.context);

// agent2 加一个任务
await agent2.registry.invoke("todo_list", { action: "add", content: "开会" }, undefined, agent2.context);

console.log("Agent 1 的 todos:");
console.log(await agent1.registry.invoke("todo_list", { action: "list" }, undefined, agent1.context));
console.log("\nAgent 2 的 todos:");
console.log(await agent2.registry.invoke("todo_list", { action: "list" }, undefined, agent2.context));

// ─── 2. 外部可观测 context 状态 ─────────────────────────────────
console.log("\n=== 2. 外部直接读 context.todos ===");
console.log("Agent 1 context.todos:", JSON.stringify(agent1.context.todos));
console.log("Agent 2 context.todos:", JSON.stringify(agent2.context.todos));

// ─── 3. Agent 自动调用 todo 工具 ────────────────────────────────
console.log("\n=== 3. Agent 自动管理 todo ===");
const agent3 = new Agent({
  llm,
  tools: [todoList],
  systemPrompt: "你是任务管理助手。用 todo_list 工具帮用户管理待办事项。",
});

const answer = await agent3.run("帮我添加三个任务：学习 TypeScript、写单元测试、部署到生产环境");
console.log("Agent 回答:", answer);

// 验证 context 里确实有数据
console.log("\nAgent 3 context 里的 todos:");
console.log(JSON.stringify(agent3.context.todos, null, 2));

// 第二轮对话，让 Agent 列出任务
console.log("\n=== 4. 第二轮对话（历史累积 + context 共享）===");
const answer2 = await agent3.run("帮我把第 2 个任务标记为完成");
console.log("Agent 回答:", answer2);
console.log("\n更新后的 todos:");
console.log(JSON.stringify(agent3.context.todos, null, 2));

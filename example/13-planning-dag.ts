import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import { Agent } from "../src/core/agent.ts";
import {
  DagPlanExecuteAgent,
  Executor,
  TaskGraph,
  type Task,
} from "../src/core/planning.ts";

const client = new OpenAI({});
const llm = new OpenAIModel(client, "deepseek-v4-flash");

// Worker agent（无工具，纯 LLM）
const workerAgent = new Agent({
  llm,
  systemPrompt: "你是一个研究助手。简洁回答，每条不超过 150 字。",
});

const executor = new Executor({ agent: workerAgent });

// ─── 场景：研究两个独立主题 → 对比 ─────────────────────────
// 预期：研究 React 和 Vue 应该并行执行，对比 task 等两者都完成才开始

console.log("=== DAG Plan & Execute（并行任务图）===\n");

const startTime = Date.now();
const ts = () => `+${Date.now() - startTime}ms`;

const dagAgent = new DagPlanExecuteAgent({
  llm,
  executor,
  concurrency: 3,
  onFailure: "skip-downstream",
  onPlan: (graph: TaskGraph) => {
    console.log(`${ts()} 【初始 Plan（DAG）】`);
    graph.list().forEach((t) => {
      const deps = t.dependencies?.length ? ` ← depends: [${t.dependencies.join(", ")}]` : "";
      console.log(`  ${t.id}: ${t.description.slice(0, 60)}${deps}`);
    });
    console.log();
  },
  onTaskStart: (t: Task) => {
    console.log(`${ts()} ▶ 开始: ${t.id} - ${t.description.slice(0, 50)}`);
  },
  onTaskEnd: (t: Task) => {
    const tag = t.status === "done" ? "✓" : t.status === "failed" ? "✗" : "⊘";
    console.log(
      `${ts()} ${tag} 完成: ${t.id} [${t.status}] → ${(t.result ?? t.error ?? "").slice(0, 60)}...`,
    );
  },
});

const goal = "研究 React 和 Vue 两个前端框架的核心特点，对比它们的差异";
console.log(`目标: ${goal}\n`);

const result = await dagAgent.run(goal);

console.log(`\n${ts()} 【最终回答】\n${result.output}`);
console.log(`\n统计: done=${result.stats.done}, failed=${result.stats.failed}, skipped=${result.stats.skipped}`);
console.log("\n【Task 最终状态】");
result.tasks.forEach((t: Task) => {
  const deps = t.dependencies?.length ? ` deps=[${t.dependencies.join(",")}]` : "";
  console.log(`  ${t.id} [${t.status}]${deps}: ${t.description.slice(0, 50)}`);
});

// 验证并行性：检查 t1 和 t2 的开始时间是否接近
console.log("\n【并行性验证】");
const t1 = result.tasks.find((t) => t.id === "t1");
const t2 = result.tasks.find((t) => t.id === "t2");
const t3 = result.tasks.find((t) => t.id === "t3");
if (t1 && t2) {
  console.log(`  t1 和 t2 应该并行（独立任务）`);
  console.log(`  t3 ${t3 ? "应该依赖 t1 + t2" : "未找到"}（等两者完成才开始）`);
}

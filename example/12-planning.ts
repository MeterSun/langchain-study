import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import { Agent } from "../src/core/agent.ts";
import {
  PlanExecuteAgent,
  Executor,
  Replanner,
  type Task,
} from "../src/core/planning.ts";

const client = new OpenAI({});
const llm = new OpenAIModel(client, "deepseek-v4-flash");

// ─── 场景 1：基础 Plan & Execute（正常流程）─────────────────

console.log("=== 场景 1：基础 Plan & Execute ===\n");

// Executor 默认复用 Agent。这里 Agent 无工具，纯 LLM 回答。
const workerAgent = new Agent({
  llm,
  systemPrompt: "你是一个研究助手。简洁回答，每条不超过 100 字。",
});

const executor = new Executor({ agent: workerAgent });

const planAgent = new PlanExecuteAgent({
  llm,
  executor,
  onPlan: (plan) => {
    console.log("【初始 Plan】");
    plan.forEach((t) => console.log(`  ${t.id}: ${t.description}`));
    console.log();
  },
  onTaskStart: (t) => console.log(`▶ 开始: ${t.id} - ${t.description}`),
  onTaskEnd: (t) => {
    const tag = t.status === "done" ? "✓" : "✗";
    console.log(`${tag} 完成: ${t.id} → ${(t.result ?? "(无)").slice(0, 80)}...`);
  },
  onReplan: (info) => {
    console.log(`  ⚠ Replan: ${info.action} - ${info.reason.slice(0, 80)}`);
  },
});

const goal1 = "比较 TypeScript 和 Rust 两种语言，给出新手选型建议";
console.log(`目标: ${goal1}\n`);

const result1 = await planAgent.run(goal1);

console.log(`\n【最终回答】\n${result1.output}`);
console.log(`\n统计: ${result1.tasks.length} 个 task，重规划 ${result1.replanCount} 次\n`);

// ─── 场景 2：模拟失败触发 Replanner ─────────────────────────

console.log("\n=== 场景 2：模拟 task 失败 → Replanner 决策 ===\n");

// 用自定义 executeFn 故意让第 2 个 task 失败
let callCount = 0;
const flakyExecutor = new Executor({
  agent: workerAgent,
  executeFn: async (task, ctx) => {
    callCount++;
    if (callCount === 2) {
      throw new Error("模拟失败：外部 API 不可用");
    }
    // 其他 task 正常调 worker agent
    return workerAgent.run(
      `${task.description}\n\n目标：${ctx.goal}\n已完成：${
        ctx.completedTasks.map((t) => t.result?.slice(0, 50)).join("; ")
      }`,
    );
  },
});

const planAgent2 = new PlanExecuteAgent({
  llm,
  executor: flakyExecutor,
  maxReplans: 2,
  onPlan: (plan) => {
    console.log("【初始 Plan】");
    plan.forEach((t) => console.log(`  ${t.id}: ${t.description}`));
    console.log();
  },
  onTaskStart: (t) => console.log(`▶ 开始: ${t.id} - ${t.description.slice(0, 50)}`),
  onTaskEnd: (t) => {
    if (t.status === "done") {
      console.log(`✓ 完成: ${t.id}`);
    } else if (t.status === "failed") {
      console.log(`✗ 失败: ${t.id} - ${t.error?.slice(0, 60)}`);
    } else if (t.status === "skipped") {
      console.log(`⊘ 跳过: ${t.id}`);
    }
  },
  onReplan: (info) => {
    console.log(`  ⚠ Replan 决策: ${info.action}`);
    console.log(`       原因: ${info.reason.slice(0, 100)}`);
  },
});

const goal2 = "写一首关于秋天的短诗";
console.log(`目标: ${goal2}\n`);

try {
  const result2 = await planAgent2.run(goal2);
  console.log(`\n【最终回答】\n${result2.output}`);
  console.log(`\n统计: ${result2.tasks.length} 个 task，重规划 ${result2.replanCount} 次`);
  console.log("\n【Task 状态】");
  result2.tasks.forEach((t: Task) => {
    console.log(`  ${t.id} [${t.status}]: ${t.description.slice(0, 50)}`);
  });
} catch (e) {
  console.log(`\n流程中止: ${e instanceof Error ? e.message : e}`);
}

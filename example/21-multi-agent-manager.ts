import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import { Agent } from "../src/core/agent.ts";
import { ManagerWorker, type Subtask } from "../src/core/multi-agent.ts";

// ─── LLM ────────────────────────────────────────────────────

const llm = new OpenAIModel(
  new OpenAI({ timeout: 120_000 }), // 2 分钟超时（decompose prompt 较长）
  "deepseek-v4-flash",
);

// ─── Manager：负责拆任务和汇总 ──────────────────────────────

const manager = new Agent({
  llm,
  systemPrompt: `你是一位技术项目经理，擅长把复杂任务拆成可执行的子任务。
你熟悉团队中每个成员的能力，会合理分派任务。
汇总时直接输出最终产物，不要寒暄。`,
  maxIterations: 3,
});

// ─── 三个 Worker ────────────────────────────────────────────

const researcher = new Agent({
  llm,
  systemPrompt: `你是一位资深技术研究员。
输出风格：条理清晰，用要点列出，每条要点不超过 50 字。
聚焦核心结论，不要长篇大论。`,
  maxIterations: 3,
});

const writer = new Agent({
  llm,
  systemPrompt: `你是一位技术作者，擅长写深入浅出的技术博客。
输出风格：结构清晰（标题/小标题/段落），代码示例简洁，每段不超过 3 行。
直接输出文章正文，不要寒暄。`,
  maxIterations: 3,
});

const reviewer = new Agent({
  llm,
  systemPrompt: `你是一位技术编辑，负责审查文章质量。
输出风格：先列出修改要点（3-5 条），再输出修订后的完整文章。
不要寒暄。`,
  maxIterations: 3,
});

// ─── 构建 ManagerWorker ─────────────────────────────────────

const mw = new ManagerWorker({
  manager,
  workers: [
    {
      name: "Researcher",
      agent: researcher,
      roleDescription: "技术研究员，负责调研和资料收集",
      skills: ["对比分析", "技术调研", "资料整理"],
    },
    {
      name: "Writer",
      agent: writer,
      roleDescription: "技术作者，负责写文章正文",
      skills: ["技术写作", "结构设计", "代码示例"],
    },
    {
      name: "Reviewer",
      agent: reviewer,
      roleDescription: "技术编辑，负责审查和修订",
      skills: ["质量审查", "文字润色", "结构优化"],
    },
  ],
  concurrency: 2, // 并发度 2：允许两个独立 subtask 同时跑
  onDecompose: (subtasks) => {
    console.log("=== Phase 1：Manager 拆解任务 ===\n");
    subtasks.forEach((s) => {
      const deps = s.dependencies?.length
        ? `，依赖 [${s.dependencies.join(", ")}]`
        : "";
      console.log(`  ${s.id} → ${s.assignedTo}${deps}`);
      console.log(`      ${s.description.slice(0, 80)}...`);
    });
    console.log("");
  },
  onSubtaskStart: (subtask, workerName) => {
    console.log(
      `▶ [${workerName}] 开始 ${subtask.id}: ${subtask.description.slice(0, 60)}...`,
    );
  },
  onSubtaskEnd: (subtask, result) => {
    const len = result.length;
    console.log(`✓ [${subtask.assignedTo}] 完成 ${subtask.id} (${len} 字)`);
  },
  onAggregate: () => {
    console.log("\n=== Phase 3：Manager 汇总 ===\n");
  },
});

// ─── 执行 ───────────────────────────────────────────────────

console.log("=== Multi-Agent Manager-Worker 演示 ===\n");
console.log("模式：Manager 拆解 → Workers 按 DAG 调度 → Manager 汇总\n");

const query =
  "写一篇 800 字的技术博客：从零实现 TypeScript Agent Framework 的核心设计。" +
  "要求覆盖：Agent Runtime、Tool Framework、Workflow Engine 三个模块的设计要点。";

console.log(`用户任务: ${query}\n`);

const result = await mw.run(query);

// ─── 执行统计 ───────────────────────────────────────────────

console.log("\n=== 执行统计 ===\n");
console.log(`子任务数: ${result.subtasks.length}`);
console.log(`执行顺序:`);

// 重建执行顺序（按完成顺序排）
const doneOrder = result.subtasks
  .filter((s) => s.status === "done")
  .map((s) => `${s.id}(${s.assignedTo})`);
console.log(`  ${doneOrder.join(" → ")}`);

console.log(`\n状态分布:`);
const statusCount: Record<string, number> = {};
result.subtasks.forEach((s: Subtask) => {
  statusCount[s.status] = (statusCount[s.status] ?? 0) + 1;
});
Object.entries(statusCount).forEach(([k, v]) => {
  console.log(`  ${k}: ${v}`);
});

// ─── 最终汇总 ───────────────────────────────────────────────

console.log("\n=== 最终博客（Manager 汇总）===\n");
console.log(result.summary);

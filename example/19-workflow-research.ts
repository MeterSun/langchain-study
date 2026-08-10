import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import {
  StateGraph,
  START,
  END,
  MemorySaver,
  interrupt,
  InterruptError,
  type WorkflowEvent,
} from "../src/core/workflow.ts";

// ─── 状态定义 ───────────────────────────────────────────────

interface ResearchState {
  topic: string;
  outline?: string; // plan 输出：研究大纲
  draft?: string; // execute 输出：草稿
  approval?: string; // review 输出（interrupt）：approved/rejected
  finalReport?: string; // finalize 输出
  attempt: number; // 重试次数（rejected 后 +1）
  log: string[];
}

// ─── LLM ────────────────────────────────────────────────────

const llm = new OpenAIModel(new OpenAI({}), "deepseek-v4-flash");

// ─── 节点：plan（生成大纲）──────────────────────────────────

const plan = async (state: ResearchState): Promise<Partial<ResearchState>> => {
  const res = await llm.chat({
    messages: [
      { role: "system", content: "你是研究规划助手。直接输出大纲，不要寒暄。" },
      {
        role: "user",
        content: `主题：${state.topic}\n\n请生成一个简短的研究大纲（3-5 个要点），用于撰写一篇 200 字的科普短文。${state.attempt > 0 ? `\n注意：这是第 ${state.attempt + 1} 次尝试，上次草稿被拒，请调整大纲方向。` : ""}`,
      },
    ],
  });
  return {
    outline: res.content,
    log: [
      `plan (attempt ${state.attempt + 1}): 生成大纲 ${res.content.length} 字`,
    ],
  };
};

// ─── 节点：execute（按大纲写草稿）──────────────────────────

const executeNode = async (
  state: ResearchState,
): Promise<Partial<ResearchState>> => {
  const res = await llm.chat({
    messages: [
      { role: "system", content: "你是科普作者。直接输出短文，不要寒暄。" },
      {
        role: "user",
        content: `主题：${state.topic}\n\n大纲：\n${state.outline}\n\n请按大纲写一篇 200 字以内的科普短文。`,
      },
    ],
  });
  return {
    draft: res.content,
    log: [`execute: 生成草稿 ${res.content.length} 字`],
  };
};

// ─── 节点：review（人工审批，interrupt）────────────────────

const review = (state: ResearchState): Partial<ResearchState> => {
  const decision = interrupt<string>(
    `\n📋 草稿预览（attempt ${state.attempt + 1}）：\n${state.draft?.slice(0, 150)}...\n\n是否通过？`,
  );
  return {
    approval: decision,
    log: [`review: 审批结果 = ${decision}`],
  };
};

// ─── 节点：finalize（通过则定稿）───────────────────────────

const finalize = async (
  state: ResearchState,
): Promise<Partial<ResearchState>> => {
  // 简单定稿：直接用 draft 作为 finalReport
  return {
    finalReport: state.draft,
    log: [`finalize: 报告定稿`],
  };
};

// ─── 构建图 ─────────────────────────────────────────────────
//
//   START → plan → execute → review → (approved ? finalize : plan)
//                                    finalize → END
//
//   review 节点用 interrupt 暂停，等待人工审批
//   rejected 时回 plan 重新规划（attempt + 1）

const graph = new StateGraph<ResearchState>()
  .addNode("plan", plan)
  .addNode("execute", executeNode)
  .addNode("review", review)
  .addNode("finalize", finalize)
  .addEdge(START, "plan")
  .addEdge("plan", "execute")
  .addEdge("execute", "review")
  .addConditionalEdge("review", (s) =>
    s.approval === "approved" ? "finalize" : "plan",
  )
  .addEdge("finalize", END);

const app = graph.compile({ maxIterations: 10 });
const saver = new MemorySaver<ResearchState>();

// ─── 执行 ───────────────────────────────────────────────────

console.log("=== Workflow 综合演示：研究 → 草稿 → 人工审批 ===\n");
console.log(
  "图结构: START → plan → execute → review → (approved ? finalize : plan)\n",
);

const topic = "量子计算的基本原理";
console.log(`主题: ${topic}\n`);

const initialState: ResearchState = {
  topic,
  attempt: 0,
  log: [],
};

// 事件追踪
const events: string[] = [];
const logEvent = (e: WorkflowEvent<ResearchState>) => {
  const e2 = e as { type: string; node?: string; from?: string; to?: string };
  if (e2.type === "node_start") {
    console.log(`  ▶ ${e2.node}`);
    events.push(`▶${e2.node}`);
  } else if (e2.type === "edge") events.push(`${e2.from}→${e2.to}`);
  else if (e2.type === "interrupt") events.push(`⏸interrupt@${e2.node}`);
  else if (e2.type === "finish") events.push(`✓finish`);
};

// ─── 第一次执行：跑到 review 暂停 ──────────────────────────

console.log("[第 1 轮] 跑到 review 暂停\n");
try {
  await app.invoke(initialState, {
    checkpointSaver: saver,
    threadId: "research-1",
    onEvent: logEvent,
  });
} catch (e) {
  if (e instanceof InterruptError) {
    console.log(`  ⏸ 暂停等待审批`);
    console.log(`  草稿: ${e.state?.draft?.slice(0, 100)}...`);
    console.log(`  事件: ${events.join(" → ")}`);
  } else {
    throw e;
  }
}

// ─── 模拟人工拒绝（第一次）──────────────────────────────────

console.log("\n[人工决策] rejected（要求重写）\n");
events.length = 0;

try {
  await app.invoke(initialState, {
    checkpointSaver: saver,
    threadId: "research-1",
    resumeValue: "rejected",
    onEvent: logEvent,
  });
} catch (e) {
  if (e instanceof InterruptError) {
    console.log(`  ⏸ 再次暂停等待审批（第 2 版草稿）`);
    console.log(`  草稿: ${e.state?.draft?.slice(0, 100)}...`);
    console.log(`  事件: ${events.join(" → ")}`);
  }
}

// ─── 模拟人工通过（第二次）──────────────────────────────────

console.log("\n[人工决策] approved（通过）\n");
events.length = 0;

const result = await app.invoke(initialState, {
  checkpointSaver: saver,
  threadId: "research-1",
  resumeValue: "approved",
  onEvent: logEvent,
});

console.log(`  ✓ 完成`);
console.log(`  事件: ${events.join(" → ")}`);

// ─── 最终结果 ───────────────────────────────────────────────

console.log("\n=== 最终报告 ===\n");
console.log(result.finalReport);

console.log(`\n=== 统计 ===`);
console.log(`  总 attempt: ${result.attempt + 1}`);
console.log(`  日志条数: ${result.log.length}`);
console.log(`  完整日志:`);
result.log.forEach((line, i) => console.log(`    ${i + 1}. ${line}`));

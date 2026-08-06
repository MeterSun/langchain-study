import {
  StateGraph,
  START,
  END,
  MemorySaver,
  interrupt,
  InterruptError,
  type WorkflowEvent,
} from "../src/core/workflow.ts";

interface CounterState {
  count: number;
  log: string[];
}

const graph = new StateGraph<CounterState>()
  .addNode("increment", (s) => ({
    count: s.count + 1,
    log: [`increment: ${s.count}→${s.count + 1}`],
  }))
  .addNode("check", (s) => ({ log: [`check: count=${s.count}`] }))
  .addEdge(START, "increment")
  .addEdge("increment", "check")
  .addConditionalEdge("check", (s) => (s.count < 3 ? "increment" : END));

const app = graph.compile();

// ─── 场景 1：完整 streaming ─────────────────────────────────

console.log("=== 场景 1：完整 streaming ===\n");

const events1: string[] = [];
for await (const event of app.stream({ count: 0, log: [] })) {
  const e = event as { type: string; node?: string; from?: string; to?: string };
  let label = e.type;
  if (e.node) label += `(${e.node})`;
  else if (e.from) label += `(${e.from}→${e.to})`;
  events1.push(label);
}

console.log("事件序列:");
events1.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));

// ─── 场景 2：中途 break ─────────────────────────────────────

console.log("\n=== 场景 2：中途 break（只看前 3 个事件）===\n");

let count = 0;
for await (const event of app.stream({ count: 0, log: [] })) {
  const e = event as { type: string; node?: string };
  count++;
  console.log(`  ${count}. ${e.type}${e.node ? `(${e.node})` : ""}`);
  if (count >= 3) {
    console.log("  → break");
    break;
  }
}
console.log(`  正常退出，共消费 ${count} 个事件`);

// ─── 场景 3：stream + interrupt ─────────────────────────────

console.log("\n=== 场景 3：stream + interrupt ===\n");

interface ApproveState {
  item: string;
  approval?: string;
  log: string[];
}

const approveGraph = new StateGraph<ApproveState>()
  .addNode("prepare", (s) => ({ log: [`prepare: ${s.item}`] }))
  .addNode("approve", (s) => {
    const d = interrupt<string>(`审批 ${s.item}?`);
    return { approval: d, log: [`approve: ${d}`] };
  })
  .addNode("execute", (s) => ({ log: [`execute: ${s.approval}`] }))
  .addEdge(START, "prepare")
  .addEdge("prepare", "approve")
  .addEdge("approve", "execute")
  .addEdge("execute", END);

const approveApp = approveGraph.compile();
const saver = new MemorySaver<ApproveState>();

console.log("[第一次 stream] 暂停在 approve");
const events2: string[] = [];
try {
  for await (const event of approveApp.stream(
    { item: "报销 1000 元", log: [] },
    { checkpointSaver: saver, threadId: "s1" },
  )) {
    const e = event as { type: string; node?: string };
    events2.push(`${e.type}${e.node ? `(${e.node})` : ""}`);
  }
  console.log("  未抛错（不符合预期）");
} catch (e) {
  if (e instanceof InterruptError) {
    console.log(`  ✓ 抛 InterruptError: ${e.interruptValue}`);
  }
}
console.log(`  事件序列: ${events2.join(" → ")}`);

console.log("\n[第二次 stream] resumeValue=yes");
const events3: string[] = [];
for await (const event of approveApp.stream(
  { item: "报销 1000 元", log: [] },
  { checkpointSaver: saver, threadId: "s1", resumeValue: "yes" },
)) {
  const e = event as { type: string; node?: string };
  events3.push(`${e.type}${e.node ? `(${e.node})` : ""}`);
}
console.log(`  事件序列: ${events3.join(" → ")}`);

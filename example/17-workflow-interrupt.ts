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

interface TransferState {
  amount: number;
  recipient: string;
  approval?: string;      // "approved" | "rejected"
  result?: string;        // 最终结果
  log: string[];
}

// ─── 节点函数 ───────────────────────────────────────────────

const prepare = (s: TransferState): Partial<TransferState> => ({
  log: [`prepare: 准备转账 ${s.amount} 元给 ${s.recipient}`],
});

const approve = (s: TransferState): Partial<TransferState> => {
  // 暂停等待人工审批。首次执行抛 InterruptError，恢复时返回 resumeValue
  const decision = interrupt<string>(
    `确认转账 ${s.amount} 元给 ${s.recipient}？`,
  );
  return {
    approval: decision,
    log: [`approve: 人工审批结果 = ${decision}`],
  };
};

const execute = (s: TransferState): Partial<TransferState> => {
  if (s.approval === "approved") {
    return {
      result: `已转账 ${s.amount} 元给 ${s.recipient}`,
      log: [`execute: 转账成功`],
    };
  }
  return {
    result: `转账已取消（审批未通过）`,
    log: [`execute: 转账取消`],
  };
};

// ─── 构建图 ─────────────────────────────────────────────────
//
//   START → prepare → approve → execute → END
//                  （interrupt 暂停）

const graph = new StateGraph<TransferState>()
  .addNode("prepare", prepare)
  .addNode("approve", approve)
  .addNode("execute", execute)
  .addEdge(START, "prepare")
  .addEdge("prepare", "approve")
  .addEdge("approve", "execute")
  .addEdge("execute", END);

const app = graph.compile();
const saver = new MemorySaver<TransferState>();

// ─── 场景 1：审批通过 ───────────────────────────────────────

console.log("=== 场景 1：转账审批通过 ===\n");

const events: string[] = [];
const logEvent = (e: WorkflowEvent<TransferState>) => {
  const e2 = e as { type: string; node?: string };
  if (e2.type === "node_start") events.push(`▶ ${e2.node}`);
  else if (e2.type === "interrupt") events.push(`⏸ interrupt @ ${e2.node}`);
  else if (e2.type === "finish") events.push(`✓ finish`);
};

const initialState: TransferState = {
  amount: 1000,
  recipient: "张三",
  log: [],
};

console.log("[第一次 invoke] 跑到 approve 会暂停");
try {
  await app.invoke(initialState, {
    checkpointSaver: saver,
    threadId: "transfer-1",
    onEvent: logEvent,
  });
  console.log("  未暂停（不符合预期）");
} catch (e) {
  if (e instanceof InterruptError) {
    console.log(`  ✓ 暂停: ${e.message}`);
    console.log(`  interruptValue: ${e.interruptValue}`);
    console.log(`  当前 state: amount=${e.state?.amount}, recipient=${e.state?.recipient}`);
  } else {
    throw e;
  }
}

console.log(`\n  事件序列: ${events.join(" → ")}`);
events.length = 0;

// 模拟人工审批
const humanDecision = "approved";
console.log(`\n[人工决策] ${humanDecision}`);

console.log("\n[第二次 invoke] 传 resumeValue，从 checkpoint 恢复");
const result1 = await app.invoke(initialState, {
  checkpointSaver: saver,
  threadId: "transfer-1",
  resumeValue: humanDecision,
  onEvent: logEvent,
});

console.log(`  结果: ${result1.result}`);
console.log(`  审批: ${result1.approval}`);
console.log(`\n  事件序列: ${events.join(" → ")}`);
console.log(`\n  完整日志:`);
result1.log.forEach((line, i) => console.log(`    ${i + 1}. ${line}`));

// ─── 场景 2：审批拒绝 ───────────────────────────────────────

console.log("\n=== 场景 2：转账审批拒绝 ===\n");

events.length = 0;
saver.clear("transfer-2");

console.log("[第一次 invoke] 暂停在 approve");
try {
  await app.invoke(
    { amount: 5000, recipient: "李四", log: [] },
    { checkpointSaver: saver, threadId: "transfer-2", onEvent: logEvent },
  );
} catch (e) {
  if (e instanceof InterruptError) {
    console.log(`  ✓ 暂停: ${e.interruptValue}`);
  }
}

console.log("\n[人工决策] rejected");
console.log("[第二次 invoke] 恢复");
const result2 = await app.invoke(
  { amount: 5000, recipient: "李四", log: [] },
  {
    checkpointSaver: saver,
    threadId: "transfer-2",
    resumeValue: "rejected",
    onEvent: logEvent,
  },
);

console.log(`  结果: ${result2.result}`);
console.log(`  审批: ${result2.approval}`);

// ─── 场景 3：验证 interrupt 前的节点不重执行 ────────────────

console.log("\n=== 场景 3：验证恢复时 prepare 不重复执行 ===\n");

let prepareCallCount = 0;
const graph2 = new StateGraph<TransferState>()
  .addNode("prepare", (s) => {
    prepareCallCount++;
    return { log: [`prepare #${prepareCallCount}`] };
  })
  .addNode("approve", (s) => {
    const d = interrupt<string>("审批");
    return { approval: d, log: [`approve: ${d}`] };
  })
  .addNode("execute", (s) => ({ result: `done: ${s.approval}`, log: [`execute`] }))
  .addEdge(START, "prepare")
  .addEdge("prepare", "approve")
  .addEdge("approve", "execute")
  .addEdge("execute", END);

const app2 = graph2.compile();
const saver2 = new MemorySaver<TransferState>();

try {
  await app2.invoke({ amount: 100, recipient: "test", log: [] }, { checkpointSaver: saver2, threadId: "t3" });
} catch (e) {
  if (e instanceof InterruptError) console.log(`  第一次: prepare 调用 ${prepareCallCount} 次`);
}

await app2.invoke({ amount: 100, recipient: "test", log: [] }, { checkpointSaver: saver2, threadId: "t3", resumeValue: "yes" });
console.log(`  第二次（恢复）: prepare 总调用 ${prepareCallCount} 次`);
console.log(`  ${prepareCallCount === 1 ? "✓ prepare 未重复（符合预期）" : "✗ prepare 重复了（不符合预期）"}`);

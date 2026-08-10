import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import { Agent } from "../src/core/agent.ts";
import {
  GroupChat,
  fixedPipelineRouter,
  lastSpeakerTermination,
  type ChatMessage,
} from "../src/core/multi-agent.ts";

// ─── LLM ────────────────────────────────────────────────────

const llm = new OpenAIModel(new OpenAI({}), "deepseek-v4-flash");

// ─── 三个角色 Agent ─────────────────────────────────────────

const researcher = new Agent({
  llm,
  systemPrompt: `你是一位资深技术研究员，擅长对比分析编程语言和技术栈。
输出风格：条理清晰，用要点列出，不要长篇大论。
每次发言 3-6 条要点即可。`,
  maxIterations: 3,
});

const coder = new Agent({
  llm,
  systemPrompt: `你是一位资深全栈工程师，精通 TypeScript 和 Rust。
输出风格：直接给出代码示例，代码前后加三引号，代码要简洁、可直接运行。
每个示例不超过 30 行。每个示例后加 1-2 句关键说明。`,
  maxIterations: 3,
});

const reviewer = new Agent({
  llm,
  systemPrompt: `你是一位技术总监，负责审查技术方案和代码质量。
输出风格：先给出整体评价（优点/缺点），再给出最终结论和选型建议。
语气要专业、明确，不模棱两可。`,
  maxIterations: 3,
});

// ─── 构建 GroupChat ─────────────────────────────────────────
//
// 固定流水线：Researcher → Coder → Reviewer
// Reviewer 发言后终止（lastSpeakerTermination）

const chat = new GroupChat({
  participants: [
    { name: "Researcher", agent: researcher, roleDescription: "技术研究员，负责调研对比" },
    { name: "Coder", agent: coder, roleDescription: "工程师，负责写代码示例" },
    { name: "Reviewer", agent: reviewer, roleDescription: "技术总监，负责审查和给出最终结论" },
  ],
  router: fixedPipelineRouter(["Researcher", "Coder", "Reviewer"]),
  termination: lastSpeakerTermination("Reviewer"),
  speakerInstruction: "输出简洁、直接，不要寒暄开场白。",
  onSpeak: (e) => {
    const preview = e.content.replace(/\n/g, " ").slice(0, 120);
    console.log(`\n┌─ Round ${e.round} · ${e.speaker} ──────────────────┐`);
    console.log(`${e.content}\n`);
    console.log(`└${"─".repeat(48 + preview.length - preview.length + e.speaker.length + String(e.round).length)}┘`);
    // 上面的分隔符对齐不重要，意思到了就行
  },
});

// ─── 执行 ───────────────────────────────────────────────────

console.log("=== Multi-Agent 流水线演示：TS vs Rust 技术对比 ===\n");

const query =
  "帮我对比 TypeScript 和 Rust 作为服务端后端开发语言的差异。" +
  "要求：(1) 调研核心差异点；(2) 各写一个简单的 HTTP Hello World 示例；(3) 给出最终选型建议。";

console.log(`用户问题: ${query}\n`);

const result = await chat.run(query);

// ─── 结果摘要 ───────────────────────────────────────────────

console.log("\n=== 讨论摘要 ===\n");
console.log(`总轮次: ${result.finalState.currentRound}`);
console.log(`发言顺序: ${result.transcript.map((m: ChatMessage) => m.speaker).join(" → ")}\n`);

console.log("=== 最终结论（Reviewer 的话）===\n");
console.log(result.lastMessage);

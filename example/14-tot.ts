import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import { ToTAgent, type ThoughtNode } from "../src/core/tot.ts";

const client = new OpenAI({});
const llm = new OpenAIModel(client, "deepseek-v4-flash");

// ─── 场景：用 ToT 写悬疑微小说 ─────────────────────────────
// 每步生成 3 个候选下一句，LLM 评估"悬疑+反转潜力"，beam=2 探索 4 层

console.log("=== Tree of Thoughts：悬疑微小说创作 ===\n");

const tot = new ToTAgent({
  llm,
  numThoughts: 3,        // 每步生成 3 个候选
  beamWidth: 2,          // 保留 top-2 继续扩展
  maxDepth: 4,           // 共 4 步
  solutionThreshold: 0.95,
  thoughtSystemPrompt: `你是一个悬疑小说作家。
给定故事当前状态，生成 3 个不同的下一句发展。
要求：
- 每个候选都要推进剧情，但方向不同（如：人物视角/物品线索/环境变化）
- newState = 当前状态 + 这一句（累积故事全文）
- 控制每句 30-50 字
- 如果故事已有完整反转和结局，把 isSolution 设为 true`,
  evalSystemPrompt: `你是一个悬疑小说编辑。
评估当前故事状态的悬疑质量，打 0-1 分：
- 0.0-0.3：平淡、无悬念、逻辑混乱
- 0.4-0.6：有悬念但缺乏反转
- 0.7-0.85：悬疑氛围好，有反转潜力
- 0.9-1.0：反转精彩、剧情完整、可作终稿

只返回 score 和 reason。`,
  onGenerate: (parent, candidates) => {
    console.log(`  [深度 ${parent.depth + 1}] 从节点 ${parent.id} 生成 ${candidates.length} 个候选:`);
    candidates.forEach((c) => {
      console.log(`    ${c.id}: "${c.thought.slice(0, 50)}..."`);
    });
  },
  onEvaluate: (nodes) => {
    console.log(`  [评估]`);
    nodes.forEach((n) => {
      console.log(`    ${n.id} score=${n.score.toFixed(2)} | ${n.thought.slice(0, 40)}...`);
    });
    console.log();
  },
});

const problem = "写一篇 200 字以内的悬疑微小说，要求有反转结局";
const initialState = "午夜，她收到一封没有署名的信。";

console.log(`问题: ${problem}`);
console.log(`初始状态: "${initialState}"\n`);

const result = await tot.solve(problem, initialState);

console.log("=== 最优路径 ===\n");
result.bestPath.forEach((node: ThoughtNode, i: number) => {
  const tag = i === 0 ? "初始" : `步骤 ${i}`;
  console.log(`[${tag}] score=${node.score.toFixed(2)} | depth=${node.depth}`);
  if (node.thought !== "(初始状态)") {
    console.log(`  这一步: ${node.thought}`);
  }
  console.log(`  状态: ${node.state.slice(0, 100)}${node.state.length > 100 ? "..." : ""}`);
  console.log();
});

console.log("=== 最终故事 ===\n");
console.log(result.bestPath[result.bestPath.length - 1]!.state);
console.log(`\n统计: 总节点 ${result.totalNodes}，最优分数 ${result.bestScore.toFixed(2)}，找到解: ${result.solved}`);

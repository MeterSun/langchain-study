import { z } from "zod";
import type { BaseLLM } from "./base";
import { structuredChat } from "./structured";

// ─── 类型定义 ───────────────────────────────────────────────

/**
 * 思考节点：树的一个状态。
 * - state：当前局面描述（如"已选了哪几个数"、"故事前半段"）
 * - thought：到达此状态的这一步思考内容
 * - score：评估分数 [0, 1]，越高越优
 * - children：从此节点继续探索生成的子节点
 */
export interface ThoughtNode {
  id: string;
  state: string;
  thought: string;
  score: number;
  depth: number;
  isSolution: boolean;
  children: ThoughtNode[];
  parent?: ThoughtNode;
}

// ─── Schemas ────────────────────────────────────────────────

const thoughtsSchema = z.object({
  thoughts: z
    .array(
      z.object({
        thought: z.string().describe("这一步的具体思考/动作"),
        newState: z.string().describe("执行此步后的新状态描述"),
        isSolution: z
          .boolean()
          .optional()
          .describe("此状态是否已是最终解"),
      }),
    )
    .describe("候选下一步思考列表"),
});

const evalSchema = z.object({
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("状态评估分数，0=死路/差，1=完美解"),
  reason: z.string().describe("打分理由"),
});

// ─── ToTAgent：Tree of Thoughts 主循环 ─────────────────────

export interface ToTOptions {
  llm: BaseLLM;
  /** 每步生成多少候选思考。默认 3。 */
  numThoughts?: number;
  /** Beam width：每步保留多少个最优节点继续扩展。默认 2。 */
  beamWidth?: number;
  /** 最大搜索深度。默认 5。 */
  maxDepth?: number;
  /** 解的分数阈值，达到即终止。默认 0.9。 */
  solutionThreshold?: number;
  /** 生成候选思考的 system prompt。 */
  thoughtSystemPrompt?: string;
  /** 评估状态的 system prompt。 */
  evalSystemPrompt?: string;
  /** 回调：每次生成候选时。 */
  onGenerate?: (parent: ThoughtNode, candidates: ThoughtNode[]) => void;
  /** 回调：每次评估完成时。 */
  onEvaluate?: (nodes: ThoughtNode[]) => void;
  /** 回调：找到解或达到深度上限时。 */
  onFinish?: (bestPath: ThoughtNode[], bestScore: number) => void;
}

export interface ToTResult {
  /** 最优路径（从根到最优叶节点）。 */
  bestPath: ThoughtNode[];
  /** 最优叶节点的分数。 */
  bestScore: number;
  /** 是否找到解（分数达到阈值）。 */
  solved: boolean;
  /** 总生成的节点数。 */
  totalNodes: number;
}

const DEFAULT_THOUGHT_PROMPT = `你是一个解决复杂问题的思考者。
给定当前状态，生成 {n} 个不同的下一步思考。
要求：
- 每个候选应该是不同的方向（不要雷同）
- newState 要清晰描述执行此步后的新局面
- 如果此步已解决问题，把 isSolution 设为 true`;

const DEFAULT_EVAL_PROMPT = `你是一个状态评估者。
给定问题描述和当前状态，打一个 0-1 的分数：
- 0.0：完全死路、违反约束、毫无希望
- 0.5：有进展但还差很远
- 0.9：接近最终解
- 1.0：完美解

只返回 score 和 reason。`;

/**
 * Tree of Thoughts Agent：树状探索 + 评估 + Beam Search。
 *
 * 算法：
 *   1. 从初始状态出发，生成 N 个候选下一步
 *   2. 用 LLM 给每个候选打分
 *   3. 保留 top-B（beamWidth）继续扩展
 *   4. 重复直到：找到 isSolution / 达到 maxDepth / 所有候选分数过低
 *
 * 与 Plan & Execute 的区别：
 * - Plan & Execute：一次性生成完整 plan，顺序执行
 * - ToT：每步探索多分支，评估后选最优继续，可"回溯"（剪掉差分支）
 *
 * 适用场景：
 * - 解空间大、需要试错的（24 点、迷宫、创意写作）
 * - 有明确评估标准的问题
 */
export class ToTAgent {
  llm: BaseLLM;
  numThoughts: number;
  beamWidth: number;
  maxDepth: number;
  solutionThreshold: number;
  thoughtSystemPrompt: string;
  evalSystemPrompt: string;
  onGenerate?: (parent: ThoughtNode, candidates: ThoughtNode[]) => void;
  onEvaluate?: (nodes: ThoughtNode[]) => void;
  onFinish?: (bestPath: ThoughtNode[], bestScore: number) => void;

  private nodeCounter = 0;

  constructor(options: ToTOptions) {
    this.llm = options.llm;
    this.numThoughts = options.numThoughts ?? 3;
    this.beamWidth = options.beamWidth ?? 2;
    this.maxDepth = options.maxDepth ?? 5;
    this.solutionThreshold = options.solutionThreshold ?? 0.9;
    this.thoughtSystemPrompt = options.thoughtSystemPrompt ?? DEFAULT_THOUGHT_PROMPT;
    this.evalSystemPrompt = options.evalSystemPrompt ?? DEFAULT_EVAL_PROMPT;
    this.onGenerate = options.onGenerate;
    this.onEvaluate = options.onEvaluate;
    this.onFinish = options.onFinish;
  }

  /** 生成候选下一步思考。 */
  private async generateThoughts(
    problem: string,
    parent: ThoughtNode,
  ): Promise<ThoughtNode[]> {
    const prompt = `问题：${problem}

当前状态（深度 ${parent.depth}）：
${parent.state}

请生成 ${this.numThoughts} 个不同的下一步思考。`;

    const data = await structuredChat(this.llm, prompt, thoughtsSchema, {
      systemPrompt: this.thoughtSystemPrompt.replace("{n}", String(this.numThoughts)),
      retries: 1,
    });

    return data.thoughts.map((t) => ({
      id: `n${this.nodeCounter++}`,
      state: t.newState,
      thought: t.thought,
      score: 0,
      depth: parent.depth + 1,
      isSolution: t.isSolution ?? false,
      children: [],
      parent,
    }));
  }

  /** 评估一批节点，原地填充 score。 */
  private async evaluateNodes(
    problem: string,
    nodes: ThoughtNode[],
  ): Promise<void> {
    if (nodes.length === 0) return;

    // 串行评估（避免 LLM 并发限流，且每个评估独立）
    for (const node of nodes) {
      const prompt = `问题：${problem}

当前状态：
${node.state}

这一步的思考：${node.thought}

请评估此状态作为解题进展的分数。`;

      try {
        const data = await structuredChat(this.llm, prompt, evalSchema, {
          systemPrompt: this.evalSystemPrompt,
          retries: 1,
        });
        node.score = data.score;
      } catch {
        node.score = 0;
      }
    }
    this.onEvaluate?.(nodes);
  }

  /** Beam Search 主循环。 */
  async solve(problem: string, initialState: string): Promise<ToTResult> {
    this.nodeCounter = 0;

    // 根节点
    const root: ThoughtNode = {
      id: "root",
      state: initialState,
      thought: "(初始状态)",
      score: 0,
      depth: 0,
      isSolution: false,
      children: [],
    };

    // 当前 beam：待扩展的节点
    let beam: ThoughtNode[] = [root];
    let bestLeaf: ThoughtNode = root;
    let totalNodes = 1;

    for (let depth = 0; depth < this.maxDepth; depth++) {
      // 1. 为 beam 中每个节点生成候选
      const candidates: ThoughtNode[] = [];
      for (const node of beam) {
        if (node.isSolution) continue;
        const thoughts = await this.generateThoughts(problem, node);
        node.children = thoughts;
        candidates.push(...thoughts);
        this.onGenerate?.(node, thoughts);
        totalNodes += thoughts.length;
      }

      if (candidates.length === 0) break;

      // 2. 评估所有候选
      await this.evaluateNodes(problem, candidates);

      // 3. 检查是否有解
      const solution = candidates.find(
        (c) => c.isSolution && c.score >= this.solutionThreshold,
      );
      if (solution) {
        bestLeaf = solution;
        break;
      }

      // 4. 更新 bestLeaf
      const depthBest = candidates.reduce((best, c) =>
        c.score > best.score ? c : best,
      );
      if (depthBest.score > bestLeaf.score) {
        bestLeaf = depthBest;
      }

      // 5. 选 top-B 进入下一轮
      candidates.sort((a, b) => b.score - a.score);
      beam = candidates.slice(0, this.beamWidth);

      // 6. 如果最优候选分数过低，提前终止
      if (beam[0]!.score < 0.1) {
        break;
      }
    }

    // 构造最优路径（从根到 bestLeaf）
    const bestPath: ThoughtNode[] = [];
    let cur: ThoughtNode | undefined = bestLeaf;
    while (cur) {
      bestPath.unshift(cur);
      cur = cur.parent;
    }

    const solved = bestLeaf.isSolution || bestLeaf.score >= this.solutionThreshold;
    this.onFinish?.(bestPath, bestLeaf.score);

    return {
      bestPath,
      bestScore: bestLeaf.score,
      solved,
      totalNodes,
    };
  }
}

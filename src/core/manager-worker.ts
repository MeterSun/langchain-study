// ─── Multi-Agent Step 2：Manager-Worker（层级协作）─────────
//
// 心智模型：项目经理 + 分包团队。
//   Manager（项目经理）：拆任务、分派、汇总
//   Worker（执行者）：跑自己被分派的子任务（独立 ReAct loop）
//   Subtask：带 dependencies 的子任务（DAG）
//
// 与 GroupChat（Step 1）的区别：
//   - 层级：Manager 指挥 Worker，Worker 之间不直接通信
//   - 任务粒度：每个 Worker 跑一个明确的 subtask（不是"发言一段话"）
//   - 并行：无依赖的 subtask 可并行执行
//   - 终止：所有 subtask 完成即结束（由调度器判断，不需要 termination fn）
//
// 三阶段流程：
//   1. Decompose：Manager 把 user query 拆成 Subtask[]（带 dependencies）
//   2. Schedule：按 dependencies 调度，并行执行就绪 subtask
//   3. Aggregate：Manager 汇总所有 subtask 结果 → 最终输出

import type { Agent } from "./agent";
import { structuredChat } from "./structured";
import { z } from "zod";

// ─── 类型定义 ───────────────────────────────────────────────

export type SubtaskStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "skipped";

/** 一个子任务。 */
export interface Subtask {
  /** 唯一 id（如 "t1"）。 */
  id: string;
  /** 任务描述（给 Worker 看的 prompt 主体）。 */
  description: string;
  /** 依赖的其他 subtask id（必须先完成）。 */
  dependencies?: string[];
  /** 分派给哪个 Worker（worker name）。不指定由调度器随机分配。 */
  assignedTo?: string;
  /** 执行结果。 */
  result?: string;
  status: SubtaskStatus;
}

/** Worker：执行 subtask 的 Agent。 */
export interface Worker {
  /** 唯一名字。 */
  name: string;
  /** 已初始化好的 Agent（已设置 system prompt）。 */
  agent: Agent;
  /** 角色描述（给 Manager 看，用于分派决策）。 */
  roleDescription?: string;
  /** 擅长的技能（给 Manager 看）。 */
  skills?: string[];
}

/** Manager-Worker 运行时状态。 */
export interface ManagerWorkerState {
  userQuery: string;
  subtasks: Subtask[];
  /** subtask.id → result（已完成的）。 */
  results: Record<string, string>;
}

export interface ManagerWorkerOptions {
  /** Manager Agent（用于 decompose 和 aggregate 两次 LLM 调用）。 */
  manager: Agent;
  /** Worker 列表。 */
  workers: Worker[];
  /** 调度循环上限（防死循环）。默认 50。 */
  maxRounds?: number;
  /** 并发度：同时执行多少个 subtask。默认 3。 */
  concurrency?: number;
  /** 回调：Manager 拆解完成。 */
  onDecompose?: (subtasks: Subtask[]) => void;
  /** 回调：某个 subtask 开始执行。 */
  onSubtaskStart?: (subtask: Subtask, workerName: string) => void;
  /** 回调：某个 subtask 执行完成。 */
  onSubtaskEnd?: (subtask: Subtask, result: string) => void;
  /** 回调：Manager 汇总完成。 */
  onAggregate?: (summary: string) => void;
}

export interface ManagerWorkerResult {
  state: ManagerWorkerState;
  /** 所有 subtask（含 status / result）。 */
  subtasks: Subtask[];
  /** Manager 的最终汇总。 */
  summary: string;
}

// ─── Manager 决策的两个 prompt ─────────────────────────────

const DECOMPOSE_PROMPT = `你是项目经理。把用户任务拆成 2-5 个子任务，每个子任务分配给一个 worker。

要求：
- 子任务之间可以有依赖（dependencies 字段填其他子任务的 id）
- 独立任务不要加依赖（允许并行）
- assignedTo 必须是给定 worker 名字之一
- 每个子任务的 description 要清晰、可独立执行（不要写"基于上一步"，要把具体要求写清楚）
- 如果某 subtask 依赖另一个，description 里可以引用 "{tid}" 占位符，调度器会替换成实际结果

输出 JSON：{
  "subtasks": [
    { "id": "t1", "description": "...", "dependencies": [], "assignedTo": "..." },
    { "id": "t2", "description": "基于 {t1} 的结果，...", "dependencies": ["t1"], "assignedTo": "..." }
  ]
}`;

const AGGREGATE_PROMPT = `你是项目经理。所有子任务已完成，请汇总成最终结果。

要求：
- 直接输出最终内容（如最终博客、最终报告），不要寒暄
- 整合所有子任务结果，去除重复，保持连贯
- 如果某子任务 failed/skipped，基于已有结果尽量完成`;

// ─── ManagerWorker 主类 ────────────────────────────────────

export class ManagerWorker {
  private manager: Agent;
  private workers: Map<string, Worker>;
  private maxRounds: number;
  private concurrency: number;
  private onDecompose?: (subtasks: Subtask[]) => void;
  private onSubtaskStart?: (subtask: Subtask, workerName: string) => void;
  private onSubtaskEnd?: (subtask: Subtask, result: string) => void;
  private onAggregate?: (summary: string) => void;

  constructor(options: ManagerWorkerOptions) {
    this.manager = options.manager;
    this.workers = new Map(options.workers.map((w) => [w.name, w]));
    if (this.workers.size === 0) {
      throw new Error("ManagerWorker 需要至少一个 worker");
    }
    this.maxRounds = options.maxRounds ?? 50;
    this.concurrency = options.concurrency ?? 3;
    this.onDecompose = options.onDecompose;
    this.onSubtaskStart = options.onSubtaskStart;
    this.onSubtaskEnd = options.onSubtaskEnd;
    this.onAggregate = options.onAggregate;
  }

  /** 执行完整流程：decompose → schedule → aggregate。 */
  async run(userQuery: string): Promise<ManagerWorkerResult> {
    // ─── Phase 1：Decompose ────────────────────────────────
    const subtasks = await this.decompose(userQuery);
    this.onDecompose?.(subtasks);

    const state: ManagerWorkerState = {
      userQuery,
      subtasks,
      results: {},
    };

    // ─── Phase 2：Schedule ─────────────────────────────────
    await this.schedule(state);

    // ─── Phase 3：Aggregate ────────────────────────────────
    const summary = await this.aggregate(state);
    this.onAggregate?.(summary);

    return { state, subtasks: state.subtasks, summary };
  }

  /** Phase 1：让 Manager 把 query 拆成 Subtask[]。 */
  private async decompose(userQuery: string): Promise<Subtask[]> {
    const workersInfo = [...this.workers.values()]
      .map(
        (w) =>
          `- ${w.name}: ${w.roleDescription ?? "(无描述)"}${
            w.skills ? `，擅长 ${w.skills.join("、")}` : ""
          }`,
      )
      .join("\n");

    const prompt = `${DECOMPOSE_PROMPT}

可用 workers：
${workersInfo}

用户任务：${userQuery}`;

    const schema = z.object({
      subtasks: z
        .array(
          z.object({
            id: z.string().describe("子任务 id，如 t1/t2"),
            description: z.string().describe("任务描述，要清晰可独立执行"),
            dependencies: z
              .array(z.string())
              .optional()
              .describe("依赖的其他 subtask id 数组，无依赖则空数组或不填"),
            assignedTo: z.string().describe("分派给哪个 worker（名字）"),
          }),
        )
        .describe("子任务列表"),
    });

    const data = await structuredChat(this.manager.llm, prompt, schema, {
      retries: 2,
    });

    // 校验 assignedTo 是否都在 workers 里
    for (const s of data.subtasks) {
      if (!this.workers.has(s.assignedTo)) {
        throw new Error(
          `Manager 拆解的 subtask ${s.id} 分派给不存在的 worker: "${s.assignedTo}"`,
        );
      }
    }

    return data.subtasks.map((s) => ({
      ...s,
      dependencies: s.dependencies ?? [],
      status: "pending" as const,
    }));
  }

  /** Phase 2：按 dependencies 调度执行。 */
  private async schedule(state: ManagerWorkerState): Promise<void> {
    const { subtasks, results } = state;
    let round = 0;

    while (true) {
      if (round++ >= this.maxRounds) {
        throw new Error(
          `ManagerWorker 调度达到上限 ${this.maxRounds} 轮，可能存在死循环`,
        );
      }

      // 1. 找 ready：pending && 所有 deps 都 done
      const ready = subtasks.filter(
        (s) =>
          s.status === "pending" &&
          (s.dependencies ?? []).every((d) => results[d] !== undefined),
      );

      // 2. 找 failed/skipped 的下游 → skip
      const toSkip = subtasks.filter(
        (s) =>
          s.status === "pending" &&
          (s.dependencies ?? []).some(
            (d) =>
              subtasks.find((x) => x.id === d)?.status === "failed" ||
              subtasks.find((x) => x.id === d)?.status === "skipped",
          ),
      );
      for (const s of toSkip) s.status = "skipped";

      // 3. 没有 ready → 检查是否全部 finished
      if (ready.length === 0) {
        const unfinished = subtasks.filter((s) => s.status === "pending");
        if (unfinished.length > 0) {
          // 有 pending 但没 ready 且没 in_progress → 卡住了（不应该发生）
          throw new Error(
            `调度卡住：${unfinished.length} 个 subtask 仍 pending 但无 ready（可能依赖环）`,
          );
        }
        break; // 全部 finished
      }

      // 4. 并行执行 ready batch（受 concurrency 限制）
      const batch = ready.slice(0, this.concurrency);
      await Promise.all(batch.map((s) => this.executeSubtask(s, state)));
    }
  }

  /** 执行单个 subtask。 */
  private async executeSubtask(
    subtask: Subtask,
    state: ManagerWorkerState,
  ): Promise<void> {
    subtask.status = "in_progress";
    const worker = this.workers.get(subtask.assignedTo!)!;

    // 清空 worker 的 memory（确保每个 subtask 上下文独立）
    worker.agent.reset();

    // 构造 prompt：subtask description + 依赖 subtask 的结果
    let prompt = subtask.description;
    for (const dep of subtask.dependencies ?? []) {
      const depResult = state.results[dep];
      if (depResult) {
        prompt = prompt.replace(`{${dep}}`, depResult);
      }
    }

    // 补充上下文：告诉 worker 这是更大任务的一部分
    const fullPrompt = `【更大任务背景】${state.userQuery}

【你的子任务】${prompt}

【依赖子任务的结果】
${(subtask.dependencies ?? [])
  .map((d) => `- ${d}:\n${state.results[d]?.slice(0, 2000) ?? "(无)"}`)
  .join("\n\n") || "(无依赖)"}

请完成你的子任务，直接输出结果：`;

    this.onSubtaskStart?.(subtask, worker.name);

    try {
      const result = await worker.agent.run(fullPrompt);
      subtask.result = result;
      subtask.status = "done";
      state.results[subtask.id] = result;
      this.onSubtaskEnd?.(subtask, result);
    } catch (e) {
      subtask.status = "failed";
      subtask.result = `Error: ${e instanceof Error ? e.message : String(e)}`;
      this.onSubtaskEnd?.(subtask, subtask.result);
    }
  }

  /** Phase 3：Manager 汇总所有 subtask 结果。 */
  private async aggregate(state: ManagerWorkerState): Promise<string> {
    const resultsSummary = state.subtasks
      .map((s) => {
        const status =
          s.status === "done" ? "✓" : s.status === "failed" ? "✗" : "⊘";
        const preview = (s.result ?? "(无结果)").slice(0, 3000);
        return `${status} ${s.id} (${s.assignedTo}): ${preview}`;
      })
      .join("\n\n---\n\n");

    const prompt = `${AGGREGATE_PROMPT}

用户原始任务：${state.userQuery}

子任务执行结果：
${resultsSummary}

请输出最终汇总：`;

    // Manager 也 reset 一下，避免 decompose 的上下文干扰
    this.manager.reset();
    return await this.manager.run(prompt);
  }
}

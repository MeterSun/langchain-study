import { z } from "zod";
import type { BaseLLM } from "./base";
import type { Agent } from "./agent";
import { structuredChat } from "./structured";

// ─── 类型定义 ───────────────────────────────────────────────

export type TaskStatus =
  | "pending"        // 待执行
  | "in_progress"    // 执行中
  | "done"           // 已完成
  | "failed"         // 失败
  | "skipped";       // 已跳过（replan 时被替换）

/** 单个子任务。Step 1 线性执行；dependencies 字段为 Step 2 DAG 预留。 */
export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  /** 执行结果（成功时）。 */
  result?: string;
  /** 失败原因（失败时）。 */
  error?: string;
  /** 依赖的 task id 列表（Step 2 DAG 用，Step 1 不使用）。 */
  dependencies?: string[];
}

/** 一次完整的计划。 */
export type Plan = Task[];

// ─── Planner：把目标拆成 Task[] ────────────────────────────

const planSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string().describe("任务 ID，如 t1、t2"),
      description: z.string().describe("具体可执行的子任务描述"),
    }),
  ),
});

const PLANNER_SYSTEM_PROMPT = `你是一个任务规划专家。
给定一个目标，把它拆解成 3-7 个可独立执行的子任务。

要求：
- 每个子任务明确、可执行（执行器只能调用 LLM 或工具）
- 按依赖顺序排列（前置任务在前）
- 粒度适中（不要拆得太细，也不要笼统）
- 任务 ID 用 t1、t2、t3...`;

export interface PlannerOptions {
  llm: BaseLLM;
  systemPrompt?: string;
}

/** 规划器：调用 LLM 把 goal 拆成有序任务列表。 */
export class Planner {
  constructor(private options: PlannerOptions) {}

  async plan(goal: string): Promise<Plan> {
    const data = await structuredChat(
      this.options.llm,
      `目标：${goal}\n\n请拆解成有序的子任务列表。`,
      planSchema,
      {
        systemPrompt: this.options.systemPrompt ?? PLANNER_SYSTEM_PROMPT,
        retries: 2,
      },
    );
    return data.tasks.map((t) => ({
      id: t.id,
      description: t.description,
      status: "pending" as const,
    }));
  }
}

// ─── Executor：执行单个 Task ───────────────────────────────

/** 自定义执行函数。接收当前 task + 已完成 task 的结果，返回执行结果。 */
export type ExecuteFn = (
  task: Task,
  context: { completedTasks: Task[]; goal: string },
) => Promise<string>;

export interface ExecutorOptions {
  /** 默认执行器：用此 Agent 跑每个 task。 */
  agent: Agent;
  /** 自定义执行函数（覆盖默认 agent）。 */
  executeFn?: ExecuteFn;
}

/** 执行器：默认复用 Agent，每个 task 调一次 agent.run()。
 *  Agent 内部 memory 会累积上下文，后续 task 能看到前面 task 的结果。 */
export class Executor {
  constructor(private options: ExecutorOptions) {}

  async execute(
    task: Task,
    completedTasks: Task[],
    goal: string,
  ): Promise<string> {
    if (this.options.executeFn) {
      return this.options.executeFn(task, { completedTasks, goal });
    }

    // 默认：把已完成 task 的结果作为上下文拼到 task 描述里
    // 让 Agent 知道前面发生了什么（即使 Agent memory 已有，显式提示更稳）
    const ctx =
      completedTasks.length > 0
        ? `\n\n【已完成任务】\n${completedTasks
            .map(
              (t) =>
                `- ${t.id}: ${t.description}\n  结果: ${(t.result ?? "(无)").slice(0, 300)}`,
            )
            .join("\n")}`
        : "";

    return this.options.agent.run(`${task.description}${ctx}`);
  }
}

// ─── Replanner：失败后决定下一步 ───────────────────────────

const replanSchema = z.object({
  action: z
    .enum(["continue", "replan", "abort"])
    .describe("continue=跳过失败任务继续；replan=重新规划剩余任务；abort=中止整个流程"),
  reason: z.string().describe("决策原因"),
  tasks: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
      }),
    )
    .optional()
    .describe("当 action=replan 时，提供新的剩余任务列表"),
});

const REPLANNER_SYSTEM_PROMPT = `你是一个任务执行监控者。
给定目标、已完成任务、当前失败任务、剩余 plan，决定下一步动作：

- continue：失败可容忍，跳过当前任务继续剩余 plan
- replan：失败说明原 plan 有问题，需要重新规划剩余任务（提供新 task 列表）
- abort：失败致命（如关键依赖缺失），中止整个流程

判断要点：
- 失败 task 是后续 task 的前置 → 倾向 replan
- 失败 task 独立、可绕过 → 倾向 continue
- 失败原因无法恢复（如 API 不可用）→ abort`;

export interface ReplannerOptions {
  llm: BaseLLM;
  systemPrompt?: string;
}

export interface ReplanDecision {
  action: "continue" | "replan" | "abort";
  reason: string;
  /** action=replan 时的新任务列表。 */
  newTasks?: Task[];
}

/** 重规划器：根据失败情况决定 continue / replan / abort。 */
export class Replanner {
  constructor(private options: ReplannerOptions) {}

  async replan(input: {
    goal: string;
    completedTasks: Task[];
    failedTask: Task;
    remainingTasks: Task[];
  }): Promise<ReplanDecision> {
    const prompt = `目标：${input.goal}

【已完成】
${input.completedTasks.map((t) => `- ${t.id}: ${t.description} → ${(t.result ?? "(无)").slice(0, 150)}`).join("\n") || "(无)"}

【失败任务】
${input.failedTask.id}: ${input.failedTask.description}
错误：${input.failedTask.error ?? "(未知)"}

【剩余 plan】
${input.remainingTasks.map((t) => `- ${t.id}: ${t.description}`).join("\n") || "(无)"}

请决定下一步。`;

    const data = await structuredChat(
      this.options.llm,
      prompt,
      replanSchema,
      {
        systemPrompt: this.options.systemPrompt ?? REPLANNER_SYSTEM_PROMPT,
        retries: 2,
      },
    );

    return {
      action: data.action,
      reason: data.reason,
      newTasks: data.tasks?.map((t) => ({
        id: t.id,
        description: t.description,
        status: "pending" as const,
      })),
    };
  }
}

// ─── PlanExecuteAgent：顶层编排 ────────────────────────────

export interface PlanExecuteOptions {
  llm: BaseLLM;
  executor: Executor;
  /** 自定义 Planner，不传则用默认。 */
  planner?: Planner;
  /** 自定义 Replanner，不传则用默认。传 false 关闭重规划。 */
  replanner?: Replanner | false;
  /** 最大重规划次数，默认 3。 */
  maxReplans?: number;
  /** 是否在所有 task 完成后用 LLM 生成最终汇总。默认 true。 */
  finalSummary?: boolean;
  /** 回调：plan 生成时。 */
  onPlan?: (plan: Plan) => void;
  /** 回调：task 开始执行。 */
  onTaskStart?: (task: Task) => void;
  /** 回调：task 执行结束（成功或失败）。 */
  onTaskEnd?: (task: Task) => void;
  /** 回调：触发重规划时。 */
  onReplan?: (info: {
    failedTask: Task;
    action: string;
    reason: string;
  }) => void;
}

export interface PlanExecuteResult {
  /** 最终输出（汇总文本，或最后一个 task 的结果）。 */
  output: string;
  /** 所有 task 的最终状态。 */
  tasks: Task[];
  /** 总重规划次数。 */
  replanCount: number;
}

/**
 * Plan & Execute Agent：先规划再执行。
 *
 * 流程：
 *   1. Planner 把 goal 拆成 Task[]
 *   2. 顺序执行每个 task，失败时调 Replanner 决定 continue/replan/abort
 *   3. 所有 task 完成后，LLM 生成最终汇总
 *
 * 与 ReAct Agent 的区别：
 *   - ReAct：每一步只看上一步，缺乏全局视图
 *   - Plan & Execute：先生成完整 plan，按计划执行，失败可重规划
 */
export class PlanExecuteAgent {
  llm: BaseLLM;
  executor: Executor;
  planner: Planner;
  replanner?: Replanner;
  maxReplans: number;
  finalSummary: boolean;
  onPlan?: (plan: Plan) => void;
  onTaskStart?: (task: Task) => void;
  onTaskEnd?: (task: Task) => void;
  onReplan?: (info: {
    failedTask: Task;
    action: string;
    reason: string;
  }) => void;

  constructor(options: PlanExecuteOptions) {
    this.llm = options.llm;
    this.executor = options.executor;
    this.planner = options.planner ?? new Planner({ llm: options.llm });
    this.replanner =
      options.replanner === false
        ? undefined
        : (options.replanner ?? new Replanner({ llm: options.llm }));
    this.maxReplans = options.maxReplans ?? 3;
    this.finalSummary = options.finalSummary ?? true;
    this.onPlan = options.onPlan;
    this.onTaskStart = options.onTaskStart;
    this.onTaskEnd = options.onTaskEnd;
    this.onReplan = options.onReplan;
  }

  async run(goal: string): Promise<PlanExecuteResult> {
    // 1. 生成初始 plan
    let plan = await this.planner.plan(goal);
    this.onPlan?.(plan);

    let replanCount = 0;
    let i = 0;

    // 2. 顺序执行，失败时触发 replan
    while (i < plan.length) {
      const task = plan[i]!;
      task.status = "in_progress";
      this.onTaskStart?.(task);

      try {
        const completed = plan
          .slice(0, i)
          .filter((t) => t.status === "done");
        const result = await this.executor.execute(task, completed, goal);
        task.status = "done";
        task.result = result;
        this.onTaskEnd?.(task);
        i++;
      } catch (e) {
        task.status = "failed";
        task.error = e instanceof Error ? e.message : String(e);
        this.onTaskEnd?.(task);

        // 无 replanner 或已达上限 → 抛错
        if (!this.replanner || replanCount >= this.maxReplans) {
          throw new Error(
            `Task "${task.id}" 失败且无法重规划：${task.error}`,
          );
        }

        // 调用 replanner 决策
        const decision = await this.replanner.replan({
          goal,
          completedTasks: plan
            .slice(0, i)
            .filter((t) => t.status === "done"),
          failedTask: task,
          remainingTasks: plan.slice(i + 1),
        });

        this.onReplan?.({
          failedTask: task,
          action: decision.action,
          reason: decision.reason,
        });

        if (decision.action === "abort") {
          throw new Error(`流程被中止：${decision.reason}`);
        }

        if (decision.action === "replan" && decision.newTasks) {
          // 用新 task 替换剩余 plan（不含当前失败的 task）
          plan = [...plan.slice(0, i), ...decision.newTasks];
          replanCount++;
          // 不增加 i，下一轮处理新的 plan[i]
        } else {
          // continue：跳过当前失败 task
          task.status = "skipped";
          i++;
        }
      }
    }

    // 3. 生成最终汇总
    const completedTasks = plan.filter((t) => t.status === "done");
    let output: string;
    if (this.finalSummary && completedTasks.length > 0) {
      const summaryPrompt = `目标：${goal}

【已完成任务及结果】
${completedTasks
  .map((t) => `- ${t.id}: ${t.description}\n  结果: ${t.result ?? "(无)"}`)
  .join("\n")}

请基于以上结果，给出针对原始目标的最终回答。`;
      const res = await this.llm.chat({
        messages: [{ role: "user", content: summaryPrompt }],
      });
      output = res.content;
    } else {
      output = completedTasks[completedTasks.length - 1]?.result ?? "(无结果)";
    }

    return { output, tasks: plan, replanCount };
  }
}

// ─── Step 2: Task Graph DAG ────────────────────────────────

/**
 * DAG 任务图。
 * 节点 = Task，边 = dependencies 关系。
 * 支持拓扑排序、就绪队列查询、循环依赖检测。
 */
export class TaskGraph {
  private tasks = new Map<string, Task>();

  constructor(tasks: Task[]) {
    for (const t of tasks) {
      this.tasks.set(t.id, t);
    }
    this.detectCycle();
  }

  /** 获取所有 task（按 id 排序）。 */
  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** 获取所有就绪 task：pending 且 dependencies 全部 done。 */
  getReady(): Task[] {
    return [...this.tasks.values()].filter((t) => {
      if (t.status !== "pending") return false;
      if (!t.dependencies?.length) return true;
      return t.dependencies.every(
        (dep) => this.tasks.get(dep)?.status === "done",
      );
    });
  }

  /** 是否所有 task 都已结束（done/failed/skipped）。 */
  isFinished(): boolean {
    return [...this.tasks.values()].every((t) => t.status !== "pending" && t.status !== "in_progress");
  }

  /** 标记 task 及其所有下游（直接或间接依赖它的 task）为 skipped。 */
  skipDownstream(failedId: string): void {
    // 找出所有直接依赖 failedId 的 task，递归 skip
    const queue = [failedId];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const t of this.tasks.values()) {
        if (t.dependencies?.includes(current) && t.status === "pending") {
          t.status = "skipped";
          t.error = `上游 task ${current} 失败/跳过`;
          queue.push(t.id);
        }
      }
    }
  }

  /** 检测循环依赖（Kahn 算法拓扑排序）。有环则抛错。 */
  private detectCycle(): void {
    const inDegree = new Map<string, number>();
    for (const t of this.tasks.values()) {
      inDegree.set(t.id, 0);
    }
    for (const t of this.tasks.values()) {
      for (const dep of t.dependencies ?? []) {
        if (!this.tasks.has(dep)) {
          throw new Error(
            `Task "${t.id}" 依赖不存在的 task "${dep}"`,
          );
        }
      }
    }
    for (const t of this.tasks.values()) {
      for (const dep of t.dependencies ?? []) {
        inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
      }
    }
    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }
    let processed = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      processed++;
      const task = this.tasks.get(id)!;
      for (const t of this.tasks.values()) {
        if (t.dependencies?.includes(id)) {
          const newDeg = (inDegree.get(t.id) ?? 0) - 1;
          inDegree.set(t.id, newDeg);
          if (newDeg === 0) queue.push(t.id);
        }
      }
    }
    if (processed !== this.tasks.size) {
      throw new Error(
        `检测到循环依赖：${processed}/${this.tasks.size} 个 task 可拓扑排序`,
      );
    }
  }
}

// ─── DAG Planner：输出带 dependencies 的 plan ──────────────

const dagPlanSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string().describe("任务 ID，如 t1、t2"),
      description: z.string().describe("具体可执行的子任务描述"),
      dependencies: z
        .array(z.string())
        .optional()
        .describe("依赖的 task id 列表。无依赖的 task 可并行执行"),
    }),
  ),
});

const DAG_PLANNER_SYSTEM_PROMPT = `你是一个任务规划专家。
给定一个目标，把它拆解成可并行执行的子任务图。

要求：
- 互相独立的任务不要建立依赖（让它们能并行执行）
- 仅在真正需要前置结果时才加 dependencies
- 任务 ID 用 t1、t2、t3...
- 粒度适中，3-8 个任务`;

export class DagPlanner {
  constructor(private options: { llm: BaseLLM; systemPrompt?: string }) {}

  async plan(goal: string): Promise<TaskGraph> {
    const data = await structuredChat(
      this.options.llm,
      `目标：${goal}\n\n请拆解成子任务图，标注 dependencies。`,
      dagPlanSchema,
      {
        systemPrompt:
          this.options.systemPrompt ?? DAG_PLANNER_SYSTEM_PROMPT,
        retries: 2,
      },
    );
    const tasks: Task[] = data.tasks.map((t) => ({
      id: t.id,
      description: t.description,
      status: "pending" as const,
      dependencies: t.dependencies,
    }));
    return new TaskGraph(tasks);
  }
}

// ─── Scheduler：DAG 调度器（并行执行）─────────────────────

export interface SchedulerOptions {
  executor: Executor;
  /** 最大并发数。默认 3。 */
  concurrency?: number;
  /** 失败处理策略：
   * - "skip-downstream"（默认）：标记 failed，下游 task 全部 skipped
   * - "abort"：第一个失败就中止整个图
   */
  onFailure?: "skip-downstream" | "abort";
  onTaskStart?: (t: Task) => void;
  onTaskEnd?: (t: Task) => void;
}

/**
 * DAG 调度器：循环取就绪 task → 并行执行 → 失败处理 → 直到全部结束。
 *
 * 并发控制：用简单的"信号量"模式，每次最多 concurrency 个 Promise 在跑。
 * 不引入 p-limit 等外部依赖。
 */
export class Scheduler {
  constructor(private options: SchedulerOptions) {}

  async run(graph: TaskGraph, goal: string): Promise<void> {
    const { concurrency = 3, onFailure = "skip-downstream" } = this.options;
    const running = new Set<Promise<void>>();
    let aborted = false;

    while (!graph.isFinished() && !aborted) {
      // 取一批就绪 task，启动执行
      const ready = graph.getReady();
      for (const task of ready) {
        if (running.size >= concurrency) break;
        if (task.status !== "pending") continue;  // 可能被其他流程改了

        task.status = "in_progress";
        this.options.onTaskStart?.(task);

        // 收集已完成 task 的结果作为上下文
        const completed = graph
          .list()
          .filter((t) => t.status === "done");

        const p = this.options.executor
          .execute(task, completed, goal)
          .then((result) => {
            task.status = "done";
            task.result = result;
            this.options.onTaskEnd?.(task);
          })
          .catch((e) => {
            task.status = "failed";
            task.error = e instanceof Error ? e.message : String(e);
            this.options.onTaskEnd?.(task);

            if (this.options.onFailure === "abort") {
              aborted = true;
            } else {
              // skip-downstream：标记下游为 skipped
              graph.skipDownstream(task.id);
            }
          })
          .finally(() => {
            running.delete(p);
          });

        running.add(p);
      }

      // 等待至少一个 task 完成，再进入下一轮
      if (running.size > 0) {
        await Promise.race(running);
      }
    }

    // 等待所有正在跑的 task 完成（abort 场景下也要等它们收尾）
    await Promise.allSettled(running);
  }
}

// ─── DagPlanExecuteAgent：DAG 顶层编排 ────────────────────

export interface DagPlanExecuteOptions {
  llm: BaseLLM;
  executor: Executor;
  planner?: DagPlanner;
  concurrency?: number;
  onFailure?: "skip-downstream" | "abort";
  finalSummary?: boolean;
  onPlan?: (graph: TaskGraph) => void;
  onTaskStart?: (t: Task) => void;
  onTaskEnd?: (t: Task) => void;
}

export interface DagPlanExecuteResult {
  output: string;
  tasks: Task[];
  /** 各状态计数。 */
  stats: { done: number; failed: number; skipped: number };
}

/**
 * DAG 版 Plan & Execute Agent。
 *
 * 与线性 PlanExecuteAgent 的区别：
 * - Planner 输出带 dependencies 的任务图
 * - Scheduler 按依赖关系并行执行（独立 task 同时跑）
 * - 失败默认 skip-downstream（自动跳过依赖链），不调 LLM 决策
 */
export class DagPlanExecuteAgent {
  llm: BaseLLM;
  executor: Executor;
  planner: DagPlanner;
  concurrency: number;
  onFailure: "skip-downstream" | "abort";
  finalSummary: boolean;
  onPlan?: (graph: TaskGraph) => void;
  onTaskStart?: (t: Task) => void;
  onTaskEnd?: (t: Task) => void;

  constructor(options: DagPlanExecuteOptions) {
    this.llm = options.llm;
    this.executor = options.executor;
    this.planner = options.planner ?? new DagPlanner({ llm: options.llm });
    this.concurrency = options.concurrency ?? 3;
    this.onFailure = options.onFailure ?? "skip-downstream";
    this.finalSummary = options.finalSummary ?? true;
    this.onPlan = options.onPlan;
    this.onTaskStart = options.onTaskStart;
    this.onTaskEnd = options.onTaskEnd;
  }

  async run(goal: string): Promise<DagPlanExecuteResult> {
    const graph = await this.planner.plan(goal);
    this.onPlan?.(graph);

    const scheduler = new Scheduler({
      executor: this.executor,
      concurrency: this.concurrency,
      onFailure: this.onFailure,
      onTaskStart: this.onTaskStart,
      onTaskEnd: this.onTaskEnd,
    });

    await scheduler.run(graph, goal);

    const tasks = graph.list();
    const done = tasks.filter((t) => t.status === "done");
    const failed = tasks.filter((t) => t.status === "failed");
    const skipped = tasks.filter((t) => t.status === "skipped");

    // 最终汇总
    let output: string;
    if (this.finalSummary && done.length > 0) {
      const summaryPrompt = `目标：${goal}

【已完成的子任务及结果】
${done
  .map(
    (t) =>
      `- ${t.id}: ${t.description}\n  结果: ${t.result ?? "(无)"}`,
  )
  .join("\n")}

${failed.length > 0 ? `【失败任务】\n${failed.map((t) => `- ${t.id}: ${t.error}`).join("\n")}\n` : ""}
${skipped.length > 0 ? `【跳过任务】\n${skipped.map((t) => `- ${t.id}: ${t.description}`).join("\n")}\n` : ""}

请基于以上结果，给出针对原始目标的最终回答。`;
      const res = await this.llm.chat({
        messages: [{ role: "user", content: summaryPrompt }],
      });
      output = res.content;
    } else {
      output = done[done.length - 1]?.result ?? "(无结果)";
    }

    return {
      output,
      tasks,
      stats: {
        done: done.length,
        failed: failed.length,
        skipped: skipped.length,
      },
    };
  }
}

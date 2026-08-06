// ─── Workflow Engine：mini LangGraph ───────────────────────
//
// 核心抽象：
//   Node  = 一个执行步骤（接收 state，返回 state patch）
//   Edge  = 步骤间的转移（普通边 or 条件边）
//   State = 在节点间流动的数据（用户自定义泛型 S）
//
// 执行模型（Pregel 简化版）：
//   START → node1 → node2 → (条件路由) → node3 → ... → END
//   每步：执行 node.fn(state) → reducer 合并 patch → 按边转移

import { AsyncLocalStorage } from "node:async_hooks";

// ─── 常量 ───────────────────────────────────────────────────

/** 图的入口节点名（虚拟节点，不执行 fn，仅作为起始边源点）。 */
export const START = "__start__";
/** 图的出口节点名（虚拟节点，到达即终止）。 */
export const END = "__end__";

// ─── 类型定义 ───────────────────────────────────────────────

/**
 * 节点函数：接收当前 state，返回部分更新（patch）。
 * patch 会通过 reducer 合并到 state。
 */
export type NodeFn<S> = (state: S) => Promise<Partial<S>> | Partial<S>;

/**
 * 路由函数：条件边用。返回下一个节点名（或 END）。
 */
export type RouterFn<S> = (state: S) => string;

/**
 * State 合并器：把节点返回的 patch 合并到 current state。
 * 默认实现是浅合并 + 数组字段追加（见 defaultReducer）。
 */
export type StateReducer<S> = (current: S, patch: Partial<S>) => S;

/** 默认 reducer：浅合并；若新旧值都是数组则追加。 */
export function defaultReducer<S>(current: S, patch: Partial<S>): S {
  const result: S = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    const cur = (result as Record<string, unknown>)[k];
    if (Array.isArray(v) && Array.isArray(cur)) {
      (result as Record<string, unknown>)[k] = [...cur, ...v];
    } else {
      (result as Record<string, unknown>)[k] = v;
    }
  }
  return result;
}

// ─── 执行事件（用于回调 / streaming）────────────────────────

export type WorkflowEvent<S> =
  | { type: "node_start"; node: string; state: S }
  | { type: "node_end"; node: string; patch: Partial<S>; state: S }
  | { type: "edge"; from: string; to: string }
  | { type: "finish"; state: S; iterations: number }
  | { type: "interrupt"; node: string; state: S };

export type WorkflowListener<S> = (event: WorkflowEvent<S>) => void;

// ─── StateGraph：图构建器 ──────────────────────────────────

export interface StateGraphOptions<S> {
  /** 自定义 state 合并器。不传则用 defaultReducer。 */
  reducer?: StateReducer<S>;
}

/**
 * 状态图构建器（不可变 API：addNode/addEdge 返回 this）。
 *
 * 用法：
 *   const graph = new StateGraph<MyState>()
 *     .addNode("plan", planFn)
 *     .addNode("execute", execFn)
 *     .addEdge(START, "plan")
 *     .addEdge("plan", "execute")
 *     .addEdge("execute", END);
 *   const app = graph.compile();
 *   const result = await app.invoke(initialState);
 */
export class StateGraph<S> {
  private nodes = new Map<string, NodeFn<S>>();
  private edges = new Map<string, string>();
  private conditionalEdges = new Map<string, RouterFn<S>>();
  private reducer: StateReducer<S>;

  constructor(options?: StateGraphOptions<S>) {
    this.reducer = options?.reducer ?? defaultReducer;
  }

  /** 注册节点。节点名不能是 START / END。 */
  addNode(name: string, fn: NodeFn<S>): this {
    if (name === START || name === END) {
      throw new Error(`节点名不能用保留字: ${name}`);
    }
    if (this.nodes.has(name)) {
      throw new Error(`节点已存在: ${name}`);
    }
    this.nodes.set(name, fn);
    return this;
  }

  /** 普通边：from → to。from 可以是 START，to 可以是 END。 */
  addEdge(from: string, to: string): this {
    if (from === END) {
      throw new Error("END 不能有出边");
    }
    if (this.conditionalEdges.has(from)) {
      throw new Error(`节点 "${from}" 已有条件边，不能加普通边`);
    }
    this.edges.set(from, to);
    return this;
  }

  /** 条件边：from 的下一个节点由 router(state) 决定。 */
  addConditionalEdge(from: string, router: RouterFn<S>): this {
    if (from === END) {
      throw new Error("END 不能有出边");
    }
    if (this.edges.has(from)) {
      throw new Error(`节点 "${from}" 已有普通边，不能加条件边`);
    }
    this.conditionalEdges.set(from, router);
    return this;
  }

  /** 编译为可执行图。 */
  compile(options?: CompileOptions): CompiledGraph<S> {
    // 校验：每个非 END 节点（含 START）必须有出边
    const allSources = new Set<string>([START]);
    for (const name of this.nodes.keys()) allSources.add(name);
    for (const src of allSources) {
      if (src === END) continue;
      if (!this.edges.has(src) && !this.conditionalEdges.has(src)) {
        throw new Error(`节点 "${src}" 没有出边`);
      }
    }
    // 校验：普通边指向的节点必须存在（或 END）
    for (const [from, to] of this.edges) {
      if (to !== END && !this.nodes.has(to)) {
        throw new Error(`节点 "${from}" 的边指向不存在的节点 "${to}"`);
      }
    }
    return new CompiledGraph({
      nodes: this.nodes,
      edges: this.edges,
      conditionalEdges: this.conditionalEdges,
      reducer: this.reducer,
      maxIterations: options?.maxIterations ?? 25,
    });
  }
}

export interface CompileOptions {
  /** 最大迭代次数（防死循环）。默认 25。 */
  maxIterations?: number;
}

// ─── CompiledGraph：可执行图 ───────────────────────────────

export interface InvokeOptions<S> {
  /** 覆盖编译期的 maxIterations。 */
  maxIterations?: number;
  /** 事件监听器（节点开始/结束、边转移、完成等）。 */
  onEvent?: WorkflowListener<S>;
  /** 会话 ID。配合 checkpointSaver 可恢复中断的执行。 */
  threadId?: string;
  /** Checkpoint 持久化器。设置后每个节点执行完保存快照。 */
  checkpointSaver?: BaseCheckpointSaver<S>;
  /** 是否从 checkpoint 恢复（默认 true；传 false 则强制从头开始）。 */
  resume?: boolean;
  /** 人工恢复值：上次 interrupt() 暂停后，用户决策的输入。
   *  设置后，节点 fn 重新执行时 interrupt() 会返回此值而非抛错。 */
  resumeValue?: unknown;
}

/**
 * 可执行图。invoke 从 START 跑到 END，返回最终 state。
 *
 * 循环保护：达到 maxIterations 抛错，防止死循环（图内可有合法循环）。
 */
export class CompiledGraph<S> {
  private nodes: Map<string, NodeFn<S>>;
  private edges: Map<string, string>;
  private conditionalEdges: Map<string, RouterFn<S>>;
  private reducer: StateReducer<S>;
  private maxIterations: number;

  constructor(params: {
    nodes: Map<string, NodeFn<S>>;
    edges: Map<string, string>;
    conditionalEdges: Map<string, RouterFn<S>>;
    reducer: StateReducer<S>;
    maxIterations: number;
  }) {
    this.nodes = params.nodes;
    this.edges = params.edges;
    this.conditionalEdges = params.conditionalEdges;
    this.reducer = params.reducer;
    this.maxIterations = params.maxIterations;
  }

  /** 从初始 state 开始执行，跑到 END，返回最终 state。
   *  若提供 checkpointSaver + threadId，可从上次中断处恢复。
   *  节点 fn 内可调 interrupt() 暂停，用 resumeValue 恢复。 */
  async invoke(state: S, options?: InvokeOptions<S>): Promise<S> {
    const maxIter = options?.maxIterations ?? this.maxIterations;
    const onEvent = options?.onEvent;
    const saver = options?.checkpointSaver;
    const threadId = options?.threadId;
    const resume = options?.resume ?? true;
    const resumeValue = options?.resumeValue;

    let current = START;
    let iteration = 0;

    // 尝试从 checkpoint 恢复
    if (resume && saver && threadId) {
      const cp = await saver.load(threadId);
      if (cp) {
        state = cp.state;
        current = cp.currentNode;
        iteration = cp.iteration;
        if (current === END) {
          // 上次已跑完，直接返回
          onEvent?.({ type: "finish", state, iterations: iteration });
          return state;
        }
      }
    }

    while (current !== END) {
      if (iteration >= maxIter) {
        throw new Error(
          `Workflow 超过最大迭代次数 (${maxIter})，可能存在死循环`,
        );
      }
      iteration++;

      // 执行节点 fn（START 是虚拟节点，不执行）
      if (current !== START) {
        const fn = this.nodes.get(current);
        if (!fn) {
          throw new Error(`节点 "${current}" 不存在`);
        }
        onEvent?.({ type: "node_start", node: current, state });

        // 用 AsyncLocalStorage 注入 resumeValue，让节点内的 interrupt() 能读到
        const exec = () => fn(state);
        let patch: Partial<S>;
        try {
          patch =
            resumeValue !== undefined
              ? await resumeStorage.run(resumeValue, exec)
              : await exec();
        } catch (e) {
          if (e instanceof InterruptError) {
            // 保存 checkpoint：重执行当前节点（因为 fn 没完成）
            e.node = current;
            e.state = state;
            if (saver && threadId) {
              await saver.save({
                threadId,
                state,
                currentNode: current,
                iteration: iteration - 1, // 重执行当前迭代
                timestamp: Date.now(),
              });
            }
            onEvent?.({ type: "interrupt", node: current, state });
            throw e;
          }
          throw e;
        }

        state = this.reducer(state, patch);
        onEvent?.({ type: "node_end", node: current, patch, state });
      }

      // 转移到下一节点
      const next = this.nextNode(current, state);
      onEvent?.({ type: "edge", from: current, to: next });
      current = next;

      // 保存 checkpoint（记录"下一个要执行的节点"）
      if (saver && threadId) {
        await saver.save({
          threadId,
          state,
          currentNode: current,
          iteration,
          timestamp: Date.now(),
        });
      }
    }

    onEvent?.({ type: "finish", state, iterations: iteration });
    return state;
  }

  /** 决定下一节点：优先条件边，其次普通边。 */
  private nextNode(current: string, state: S): string {
    const router = this.conditionalEdges.get(current);
    if (router) {
      const next = router(state);
      if (next !== END && !this.nodes.has(next)) {
        throw new Error(
          `条件边路由返回不存在的节点: "${next}"（来自 "${current}"）`,
        );
      }
      return next;
    }
    const next = this.edges.get(current);
    if (!next) {
      throw new Error(`节点 "${current}" 没有出边`);
    }
    return next;
  }

  /**
   * 流式执行：返回事件 AsyncIterable，调用方用 for await 消费。
   *
   * 与 invoke 的区别：
   *   - invoke：跑完返回最终 state（push 模式，事件通过 onEvent 回调）
   *   - stream：yield 每个事件（pull 模式，调用方可中途 break）
   *
   * 用法：
   *   for await (const event of app.stream(state)) {
   *     if (event.type === "node_end") console.log(event.node);
   *   }
   *
   * interrupt 时 yield interrupt 事件后抛 InterruptError（调用方需 catch）。
   */
  async *stream(
    state: S,
    options?: Omit<InvokeOptions<S>, "onEvent">,
  ): AsyncGenerator<WorkflowEvent<S>, S, undefined> {
    const queue: WorkflowEvent<S>[] = [];
    let resolveWait: () => void = () => {};
    const waitForEvent = () =>
      new Promise<void>((r) => {
        resolveWait = r;
      });

    const onEvent = (e: WorkflowEvent<S>) => {
      queue.push(e);
      resolveWait();
    };

    let invokeError: unknown = null;
    const invokePromise = this.invoke(state, { ...options, onEvent }).catch(
      (e) => {
        invokeError = e;
        resolveWait();
      },
    );

    try {
      while (true) {
        // 队列空且 invoke 未抛错 → 等待
        if (queue.length === 0) {
          if (invokeError !== null) {
            throw invokeError;
          }
          await waitForEvent();
        }
        // 消费队列
        while (queue.length > 0) {
          const event = queue.shift()!;
          yield event;
          if (event.type === "finish") {
            await invokePromise;
            return event.state;
          }
        }
      }
    } finally {
      // 吞掉未处理的 rejection（调用方 break 时 invoke 仍在后台跑）
      invokePromise.catch(() => {});
    }
  }
}

// ─── Checkpoint：状态快照 + 恢复 ───────────────────────────

/** 一次执行快照。记录"下一个要执行的节点"，恢复时从此节点继续。 */
export interface Checkpoint<S> {
  threadId: string;
  state: S;
  /** 下一个要执行的节点（恢复时从此处进入 while 循环）。 */
  currentNode: string;
  iteration: number;
  timestamp: number;
}

/** Checkpoint 持久化器接口。 */
export interface BaseCheckpointSaver<S> {
  save(cp: Checkpoint<S>): Promise<void>;
  load(threadId: string): Promise<Checkpoint<S> | undefined>;
  /** 列出所有 thread 的最新快照（调试/监控用）。 */
  list?(): Promise<Checkpoint<S>[]>;
  /** 删除某 thread 的快照。 */
  clear?(threadId: string): Promise<void>;
}

/** 内存 Checkpoint 持久化器。进程结束即丢失，适合演示和测试。 */
export class MemorySaver<S> implements BaseCheckpointSaver<S> {
  private store = new Map<string, Checkpoint<S>>();

  async save(cp: Checkpoint<S>): Promise<void> {
    this.store.set(cp.threadId, cp);
  }

  async load(threadId: string): Promise<Checkpoint<S> | undefined> {
    return this.store.get(threadId);
  }

  async list(): Promise<Checkpoint<S>[]> {
    return [...this.store.values()];
  }

  async clear(threadId: string): Promise<void> {
    this.store.delete(threadId);
  }
}

/**
 * 文件 Checkpoint 持久化器。每个 thread 一个 JSON 文件，跨进程可恢复。
 *
 * 文件布局：
 *   <dir>/<threadId>.json   → Checkpoint<S> 的 JSON
 *
 * 注意：S 必须可序列化（无函数、无循环引用、无 Symbol 键）。
 */
export class FileSaver<S> implements BaseCheckpointSaver<S> {
  constructor(private dir: string) {}

  async save(cp: Checkpoint<S>): Promise<void> {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(this.dir, { recursive: true });
    const path = this.pathFor(cp.threadId);
    writeFileSync(path, JSON.stringify(cp, null, 2));
  }

  async load(threadId: string): Promise<Checkpoint<S> | undefined> {
    const { existsSync, readFileSync } = await import("node:fs");
    const path = this.pathFor(threadId);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf-8")) as Checkpoint<S>;
  }

  async list(): Promise<Checkpoint<S>[]> {
    const { readdirSync, readFileSync } = await import("node:fs");
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
      return files.map(
        (f) =>
          JSON.parse(
            readFileSync(`${this.dir}/${f}`, "utf-8"),
          ) as Checkpoint<S>,
      );
    } catch {
      return [];
    }
  }

  async clear(threadId: string): Promise<void> {
    const { unlinkSync, existsSync } = await import("node:fs");
    const path = this.pathFor(threadId);
    if (existsSync(path)) unlinkSync(path);
  }

  private pathFor(threadId: string): string {
    // 防路径穿越：只允许字母数字下划线减号
    const safe = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${this.dir}/${safe}.json`;
  }
}

// ─── Human-in-the-loop：interrupt + resume ────────────────

/** resumeValue 的异步上下文存储。interrupt() 通过它读取"是否在恢复中"。 */
const resumeStorage = new AsyncLocalStorage<unknown>();

/**
 * 在节点 fn 内调用，暂停工作流等待人工输入。
 *
 * 行为：
 *   - 首次执行（无 resumeValue）：抛 InterruptError，invoke 捕获并保存 checkpoint
 *   - 恢复执行（有 resumeValue）：返回 resumeValue，节点 fn 继续往下走
 *
 * 用法：
 *   const approval = interrupt("需要审批此操作");
 *   if (approval === "approved") { ... }
 *
 * 注意：恢复时节点 fn 会从头重新执行，interrupt() 之前的代码会再次跑。
 *       有副作用的代码需自行幂等。
 *
 * @param value 传给调用方的问题/上下文（如"需要审批：操作描述"）
 */
export function interrupt<T = unknown>(value?: unknown): T {
  const resumeValue = resumeStorage.getStore();
  if (resumeValue !== undefined) {
    return resumeValue as T;
  }
  throw new InterruptError(value);
}

/** interrupt() 抛出的错误。调用方 catch 后可读取 state/value 决策。 */
export class InterruptError<S = unknown> extends Error {
  /** interrupt() 传入的值（问题描述/待审批内容）。 */
  interruptValue: unknown;
  /** 中断时的状态（invoke 自动填充）。 */
  state?: S;
  /** 中断的节点名（invoke 自动填充）。 */
  node?: string;

  constructor(interruptValue?: unknown) {
    super(
      `Workflow interrupted${
        interruptValue !== undefined ? `: ${String(interruptValue)}` : ""
      }`,
    );
    this.name = "InterruptError";
    this.interruptValue = interruptValue;
  }
}

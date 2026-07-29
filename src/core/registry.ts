import type { Tool, ToolMetadata } from "./tool";
import type { ToolContext } from "./type";

export interface InvokeOptions {
  /** 单次执行超时（毫秒），超时抛错。 */
  timeoutMs?: number;
  /** 失败后重试次数（不含首次）。默认 0。 */
  retries?: number;
  /** 重试间隔（毫秒）。默认 0。 */
  retryDelayMs?: number;
}

const DEFAULT_TIMEOUT = 30_000;

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /** 注册工具。重名会覆盖。 */
  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  /** 批量注册。 */
  registerAll(tools: Tool[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  /** 按名获取。 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 是否已注册。 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 注销工具。 */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** 列出全部工具。 */
  list(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * 按条件搜索工具。
   * - category: 精确匹配 metadata.category
   * - tag: 匹配 metadata.tags 中任一
   * - nameContains: name 模糊匹配
   */
  search(query: {
    category?: string;
    tag?: string;
    nameContains?: string;
  }): Tool[] {
    return this.list().filter((t) => {
      const meta = t.metadata;
      if (query.category && meta?.category !== query.category) return false;
      if (query.tag && !(meta?.tags ?? []).includes(query.tag)) return false;
      if (
        query.nameContains &&
        !t.name.toLowerCase().includes(query.nameContains.toLowerCase())
      )
        return false;
      return true;
    });
  }

  /**
   * 调用工具，带 timeout + retry 保护。
   * 参数会先经 tool.parameters.parse 校验（由 tool.execute 内部完成）。
   */
  async invoke(
    name: string,
    args: Record<string, unknown>,
    options?: InvokeOptions,
    context?: ToolContext,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found in registry`);
    }
    return this.invokeTool(tool, args, options, context);
  }

  /** 直接对 Tool 实例执行（即使未注册也能用 timeout/retry）。 */
  async invokeTool(
    tool: Tool,
    args: Record<string, unknown>,
    options?: InvokeOptions,
    context?: ToolContext,
  ): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT;
    const retries = options?.retries ?? 0;
    const retryDelayMs = options?.retryDelayMs ?? 0;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.executeWithTimeout(tool, args, timeoutMs, context);
      } catch (e) {
        lastError = e;
        // 超时/错误时按需重试
        if (attempt < retries && retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  private async executeWithTimeout(
    tool: Tool,
    args: Record<string, unknown>,
    timeoutMs: number,
    context?: ToolContext,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await Promise.race([
        tool.execute(args, context),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new Error(`Tool "${tool.name}" timed out after ${timeoutMs}ms`));
          });
        }),
      ]);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

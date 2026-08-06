import type { BaseLLM } from "./base";
import type { Agent } from "./agent";
import { END, type NodeFn } from "./workflow";
import type { Message } from "./type";

// ─── 节点包装器：把 Agent / LLM / Tool 包装为 Workflow 节点 ──
//
// 这些 helper 不是必需的 —— 节点 fn 本质是 (state) => patch，
// 任何异步逻辑都能直接写在 fn 里。helper 只是简化常见模式。
//
// Subgraph 也不需要专门 API：节点 fn 内调子图的 invoke 即可：
//
//   const sub = new StateGraph<SubState>()...compile();
//   addNode("sub", async (state) => {
//     const r = await sub.invoke({ input: state.x });
//     return { y: r.output };
//   })

/** 把 Agent 包装为 Workflow 节点。
 *
 * @param agent Agent 实例（内部 memory 会累积上下文）
 * @param inputKey 从 state 的哪个字段取输入（string）
 * @param outputKey 结果写入 state 的哪个字段
 */
export function agentNode<S>(
  agent: Agent,
  inputKey: keyof S & string,
  outputKey: keyof S & string,
): NodeFn<S> {
  return async (state: S) => {
    const input = state[inputKey] as unknown as string;
    const result = await agent.run(input);
    return { [outputKey]: result } as unknown as Partial<S>;
  };
}

/** 把单次 LLM 调用包装为 Workflow 节点（无工具、无循环）。
 *
 * @param llm LLM 实例
 * @param prompt 根据 state 动态生成 user prompt
 * @param outputKey 结果写入 state 的哪个字段
 * @param systemPrompt 可选 system prompt
 */
export function llmNode<S>(
  llm: BaseLLM,
  prompt: (state: S) => string,
  outputKey: keyof S & string,
  systemPrompt?: string,
): NodeFn<S> {
  return async (state: S) => {
    const messages: Message[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt(state) });
    const res = await llm.chat({ messages });
    return { [outputKey]: res.content } as unknown as Partial<S>;
  };
}

/** 条件路由 helper：根据 state 字段值决定下一节点。
 *
 * 用法：.addConditionalEdge("node", routeBy("status", {
 *   success: "next", failed: "retry", done: END,
 * }))
 */
export function routeBy<S>(
  field: keyof S & string,
  mapping: Record<string, string>,
): (state: S) => string {
  return (state: S) => {
    const value = String(state[field]);
    return mapping[value] ?? END;
  };
}

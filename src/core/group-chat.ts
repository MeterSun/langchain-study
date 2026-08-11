// ─── Multi-Agent Step 1：GroupChat（扁平协作）───────────────
//
// 心智模型：一群 Agent 围坐一张桌子，桌子中间有一块"共享黑板"。
//   Router 决定"下一个谁发言"；
//   发言人先读黑板（所有历史消息），再把自己的发言写在黑板上；
//   Termination 决定"什么时候散会"。
//
// 与 Manager-Worker（Step 2）的区别：
//   - 扁平：所有 Agent 平等，无层级
//   - 串行：一次只有一个发言人（因为只有一块共享黑板）
//   - 对话式：每次发言是一整段话（不是"任务+结果"）
//
// 与单个 Agent 的 ReAct 循环的关系：
//   每个参与者本身就是一个 Agent（ReAct loop）。GroupChat 是在外层
//   再套一层"谁来跑"的调度循环。

import type { Agent } from "./agent";
import type { BaseLLM } from "./base";
import { structuredChat } from "./structured";
import { z } from "zod";

// ─── 类型定义 ───────────────────────────────────────────────

/** 共享黑板上的一条消息。 */
export interface ChatMessage {
  /** 发言者名字（"user"/Agent name） */
  speaker: string;
  /** 消息内容 */
  content: string;
  /** 第几轮发言（用于调试/限制） */
  round: number;
}

/** GroupChat 的运行时状态（传给 Router / Termination / 回调）。 */
export interface GroupChatState {
  messages: ChatMessage[];
  /** 当前轮次（每次有一个新的 agent 发言 round +1）。 */
  currentRound: number;
  /** 最后一个发言人名字（user 的不算）。 */
  lastSpeaker?: string;
  /** 初始用户问题。 */
  userQuery: string;
}

/**
 * 一个参与者：包装一个 Agent + 它的名字。
 *
 * 设计说明：
 *   Agent 本身有 memory（对话历史）。为了避免"Agent 内部记忆"
 *   和"GroupChat 共享黑板"的信息重复/冲突，每次让该参与者
 *   发言前都会 agent.reset()，然后把共享黑板格式化成一段
 *   prompt 前缀传给它，让它只看到一致的上下文。
 */
export interface ChatParticipant {
  /** 唯一名字（Router/Termination 用它来引用）。 */
  name: string;
  /** 已初始化好的 Agent（已经设置了 system prompt）。 */
  agent: Agent;
  /** 可选：角色描述，在 formatPromptForSpeaker 时展示给其他 Agent。 */
  roleDescription?: string;
}

/** 路由函数：从当前 state 选出"下一个发言人的名字"。支持同步或异步。 */
export type RouterFn = (
  state: GroupChatState,
  participantNames: string[],
) => string | Promise<string>;

/** 终止函数：返回 true 就结束讨论。 */
export type TerminationFn = (state: GroupChatState) => boolean;

/** 每次有人发言时触发的回调。 */
export type GroupChatListener = (event: {
  type: "speak";
  round: number;
  speaker: string;
  content: string;
  state: GroupChatState;
}) => void;

// ─── 默认实现：黑板格式化 ──────────────────────────────────

/**
 * 把共享黑板格式化成一段文本，发给即将发言的 Agent。
 *
 * 输出形如：
 *   === 历史对话 ===
 *   [user]: 帮我分析 TS vs Rust
 *   [Researcher]: 研究结果：TS 适合前端...
 *   [Coder]: 代码示例：...
 *   === 轮到你了：Reviewer ===
 *   请基于以上对话，你的角色（代码审查者）给出你的意见。
 */
export function formatPromptForSpeaker(
  state: GroupChatState,
  speaker: ChatParticipant,
  customInstruction?: string,
): string {
  const history = state.messages
    .map((m) => `[${m.speaker}]: ${m.content}`)
    .join("\n\n");

  const intro = speaker.roleDescription
    ? `你是【${speaker.name}】，角色：${speaker.roleDescription}。`
    : `你是【${speaker.name}】。`;

  const instruction =
    customInstruction ?? "请基于以上讨论，输出你这一轮的发言。";

  return `=== 历史讨论（共享黑板） ===

${history}

=== 轮到你发言 ===

${intro}
${instruction}`;
}

// ─── 内置 Router ───────────────────────────────────────────

/**
 * 轮询路由：按 participant 注册顺序轮着来。
 * 到最后一个后回第一个。
 */
export function roundRobinRouter(): RouterFn {
  let cursor = 0;
  return (_state, names) => {
    const name = names[cursor % names.length]!;
    cursor++;
    return name;
  };
}

/**
 * 固定流水线路由：按 participant 顺序逐个发言，跑完一轮就返回到 speaker 空串。
 * 配合 lastSpeakerTermination 或 pipelineTermination 使用可自动结束。
 *
 * @param sequence 显式发言顺序（参与者名字数组）。不传则用注册顺序。
 * @param loop true：到末尾后回到开头（循环流水线）；false：到末尾后抛错
 */
export function fixedPipelineRouter(
  sequence?: string[],
  loop = false,
): RouterFn {
  let cursor = 0;
  return (_state, names) => {
    const order = sequence ?? names;
    if (cursor >= order.length) {
      if (loop) cursor = 0;
      else
        throw new Error(
          `fixedPipelineRouter 已跑完所有步骤（cursor=${cursor}），请配置 termination 或 loop=true`,
        );
    }
    const name = order[cursor]!;
    if (!names.includes(name)) {
      throw new Error(
        `fixedPipelineRouter: 步骤 "${name}" 不在 participants 中`,
      );
    }
    cursor++;
    return name;
  };
}

/**
 * LLM 路由：让 LLM 根据当前对话判断下一个谁发言。
 *
 * 适合"多 Agent 辩论 / 自由讨论"场景：谁该说话不是固定的，
 * 而是看讨论进展动态决定。
 */
export function createLlmRouter(llm: BaseLLM, systemPrompt?: string): RouterFn {
  const schema = z.object({
    nextSpeaker: z.string().describe("下一个发言人的名字（必须是候选之一）"),
    reason: z.string().describe("为什么选这个人发言"),
  });
  const DEFAULT_PROMPT = `你是讨论会主持人。根据当前讨论进展和各参与者的角色，选出下一个最合适的发言人。
如果讨论已经充分，可以返回指定的总结者来收尾。
只从给定的候选里选，不要凭空造名字。`;

  return async (state, names) => {
    const history = state.messages
      .slice(-6) // 最近 6 条，避免上下文过长
      .map((m) => `[${m.speaker}]: ${m.content.slice(0, 400)}`)
      .join("\n\n");

    const prompt = `用户原始问题：${state.userQuery}

最近讨论：
${history}

参与者名单（角色）：
${names.join("、")}

下一个该谁发言？`;

    const data = await structuredChat(llm, prompt, schema, {
      systemPrompt: systemPrompt ?? DEFAULT_PROMPT,
      retries: 1,
    });
    if (!names.includes(data.nextSpeaker)) {
      // LLM 返回了不存在的名字 → fallback 到最后一个发言人之后的下一个
      const idx = state.lastSpeaker ? names.indexOf(state.lastSpeaker) : -1;
      return names[(idx + 1) % names.length]!;
    }
    return data.nextSpeaker;
  };
}

// ─── 内置 Termination ──────────────────────────────────────

/** 达到最大轮数时结束。 */
export function maxRoundsTermination(max: number): TerminationFn {
  return (state) => state.currentRound >= max;
}

/** 最后一个指定发言人（名字）发言过 → 结束。
 *  适合固定流水线：最后一个角色收尾。 */
export function lastSpeakerTermination(name: string): TerminationFn {
  return (state) => state.lastSpeaker === name;
}

/** 组合多个 termination：任一命中即结束。 */
export function anyTermination(...terms: TerminationFn[]): TerminationFn {
  return (state) => terms.some((t) => t(state));
}

// ─── GroupChat：主类 ───────────────────────────────────────

export interface GroupChatOptions {
  participants: ChatParticipant[];
  router: RouterFn;
  termination: TerminationFn;
  onSpeak?: GroupChatListener;
  /** 发给每个发言人时的额外指令（拼接在 formatPromptForSpeaker 末尾）。 */
  speakerInstruction?: string;
  /** 自定义 prompt 格式化函数。不传用默认 formatPromptForSpeaker。 */
  formatPrompt?: (state: GroupChatState, speaker: ChatParticipant) => string;
}

export interface GroupChatResult {
  finalState: GroupChatState;
  /** 最后一条非 user 的消息内容。 */
  lastMessage: string;
  /** 每轮发言记录（只含 agent 发言）。 */
  transcript: ChatMessage[];
}

export class GroupChat {
  private participants: Map<string, ChatParticipant>;
  private router: RouterFn;
  private termination: TerminationFn;
  private onSpeak?: GroupChatListener;
  private speakerInstruction?: string;
  private formatPrompt: (
    state: GroupChatState,
    speaker: ChatParticipant,
  ) => string;

  constructor(options: GroupChatOptions) {
    this.participants = new Map(options.participants.map((p) => [p.name, p]));
    if (this.participants.size === 0) {
      throw new Error("GroupChat 需要至少一个 participant");
    }
    this.router = options.router;
    this.termination = options.termination;
    this.onSpeak = options.onSpeak;
    this.speakerInstruction = options.speakerInstruction;
    this.formatPrompt =
      options.formatPrompt ??
      ((s, p) => formatPromptForSpeaker(s, p, this.speakerInstruction));
  }

  async run(userQuery: string): Promise<GroupChatResult> {
    // State：共享黑板
    const state: GroupChatState = {
      messages: [{ speaker: "user", content: userQuery, round: 0 }],
      currentRound: 0,
      userQuery,
    };

    // 安全网：额外最多 N 轮（防 termination/router bug 导致死循环）
    const SAFETY_MAX = 100;

    while (!this.termination(state)) {
      if (state.currentRound >= SAFETY_MAX) {
        throw new Error(
          `GroupChat 达到安全上限 ${SAFETY_MAX} 轮。请检查 termination / router 是否正确。`,
        );
      }

      const names = [...this.participants.keys()];
      let nextName: string;
      try {
        nextName = await this.router(state, names);
      } catch (e) {
        // Router 抛错（如 fixedPipeline 跑完）→ 结束
        break;
      }

      if (!this.participants.has(nextName)) {
        throw new Error(`Router 返回了不存在的 participant: "${nextName}"`);
      }
      const speaker = this.participants.get(nextName)!;

      // 1. 清空发言人自己的 memory（防止和共享黑板信息重叠）
      speaker.agent.reset();

      // 2. 格式化共享黑板 → 给这个发言人的 prompt
      const prompt = this.formatPrompt(state, speaker);

      // 3. 让发言人跑自己的 Agent loop（ReAct）
      const content = await speaker.agent.run(prompt);

      // 4. 把结果写到共享黑板
      state.currentRound++;
      state.messages.push({
        speaker: speaker.name,
        content,
        round: state.currentRound,
      });
      state.lastSpeaker = speaker.name;

      // 5. 回调
      this.onSpeak?.({
        type: "speak",
        round: state.currentRound,
        speaker: speaker.name,
        content,
        state: { ...state, messages: [...state.messages] },
      });
    }

    const transcript = state.messages.filter((m) => m.speaker !== "user");
    const lastAgent = transcript[transcript.length - 1];
    return {
      finalState: state,
      lastMessage: lastAgent?.content ?? "",
      transcript,
    };
  }
}

// ─── Multi-Agent 索引文件 ─────────────────────────────────
//
// 拆分为两个模块：
//   - group-chat.ts      Step 1：GroupChat（扁平协作）
//   - manager-worker.ts   Step 2：Manager-Worker（层级协作）
//
// 本文件重新导出所有公共 API，保持向后兼容。

export {
  // 类型
  type ChatMessage,
  type GroupChatState,
  type ChatParticipant,
  type RouterFn,
  type TerminationFn,
  type GroupChatListener,
  type GroupChatOptions,
  type GroupChatResult,
  // 工具函数
  formatPromptForSpeaker,
  roundRobinRouter,
  fixedPipelineRouter,
  createLlmRouter,
  maxRoundsTermination,
  lastSpeakerTermination,
  anyTermination,
  // 主类
  GroupChat,
} from "./group-chat";

export {
  // 类型
  type SubtaskStatus,
  type Subtask,
  type Worker,
  type ManagerWorkerState,
  type ManagerWorkerOptions,
  type ManagerWorkerResult,
  // 主类
  ManagerWorker,
} from "./manager-worker";

import { z } from "zod";
import { defineTool } from "../core/tool.ts";
import type { ToolContext } from "../core/type.ts";

type TodoStatus = "pending" | "in_progress" | "done";

interface TodoItem {
  id: number;
  content: string;
  status: TodoStatus;
}

const STATUS_ICON: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  done: "[x]",
};

const STATUS_LABEL: Record<TodoStatus, string> = {
  pending: "未执行",
  in_progress: "执行中",
  done: "已执行",
};

/**
 * 从 context 获取 todo 列表。不存在则初始化。
 * context 由 Agent 持有，跨工具调用共享同一引用。
 */
function getTodos(context?: ToolContext): TodoItem[] {
  if (!context) return [];
  if (!context.todos) {
    context.todos = [];
    context._todoNextId = 1;
  }
  return context.todos as TodoItem[];
}

function getNextId(context?: ToolContext): number {
  if (!context) return 1;
  const id = (context._todoNextId as number) ?? 1;
  context._todoNextId = id + 1;
  return id;
}

/**
 * Todo List 工具：管理任务列表。
 * 三种状态：pending（未执行）、in_progress（执行中）、done（已执行）。
 * action：add / list / start / complete / remove。
 * 状态存储在 Agent 的 context.todos 中。
 */
export const todoList = defineTool({
  name: "todo_list",
  description:
    "管理待办任务列表。action：add（添加）、list（列出全部）、start（标记执行中）、complete（标记已执行）、remove（删除）。任务有三种状态：未执行、执行中、已执行。",
  parameters: z.object({
    action: z
      .enum(["add", "list", "start", "complete", "remove"])
      .describe("要执行的操作"),
    content: z.string().optional().describe("任务内容，add 时必填"),
    id: z
      .number()
      .int()
      .optional()
      .describe("任务 ID，start/complete/remove 时必填"),
  }),
  metadata: {
    category: "productivity",
    tags: ["todo", "task", "list"],
    version: "1.1.0",
  },
  execute: async ({ action, content, id }, context) => {
    const todos = getTodos(context);

    switch (action) {
      case "add": {
        if (!content) throw new Error("add 操作需要 content 参数");
        const item: TodoItem = {
          id: getNextId(context),
          content,
          status: "pending",
        };
        todos.push(item);
        return `已添加任务 #${item.id}: ${item.content}`;
      }
      case "list": {
        if (todos.length === 0) return "当前没有任务";
        return todos
          .map(
            (t) =>
              `${STATUS_ICON[t.status]} #${t.id} ${t.content}（${STATUS_LABEL[t.status]}）`,
          )
          .join("\n");
      }
      case "start": {
        if (id === undefined) throw new Error("start 操作需要 id 参数");
        const item = todos.find((t) => t.id === id);
        if (!item) throw new Error(`任务 #${id} 不存在`);
        if (item.status === "done")
          throw new Error(`任务 #${id} 已执行，无法标记为执行中`);
        item.status = "in_progress";
        return `任务 #${item.id} 已标记为执行中: ${item.content}`;
      }
      case "complete": {
        if (id === undefined) throw new Error("complete 操作需要 id 参数");
        const item = todos.find((t) => t.id === id);
        if (!item) throw new Error(`任务 #${id} 不存在`);
        item.status = "done";
        return `任务 #${item.id} 已标记为已执行: ${item.content}`;
      }
      case "remove": {
        if (id === undefined) throw new Error("remove 操作需要 id 参数");
        const idx = todos.findIndex((t) => t.id === id);
        if (idx === -1) throw new Error(`任务 #${id} 不存在`);
        const removed = todos[idx];
        todos.splice(idx, 1);
        if (!removed) throw new Error(`任务 #${id} 不存在`);
        return `已删除任务 #${removed.id}: ${removed.content}`;
      }
    }
  },
});

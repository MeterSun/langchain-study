import { z } from "zod";
import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import {
  generateStructured,
  extractJSON,
  structuredChat,
} from "../src/core/structured.ts";

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL!,
  apiKey: process.env.OPENAI_API_KEY!,
});
const llm = new OpenAIModel(client, "deepseek-v4-flash");

// ─── 1. extractJSON 工具函数测试 ───────────────────────────────
console.log("=== 1. extractJSON 测试 ===");
console.log("纯 JSON:", extractJSON('{"name":"Tom","age":28}'));
console.log("代码块:", extractJSON('```json\n{"name":"Tom","age":28}\n```'));
console.log(
  "带文字:",
  extractJSON('好的，结果是：\n{"name":"Tom","age":28}\n希望有帮助'),
);

// ─── 2. generateStructured 基础用法 ────────────────────────────
console.log("\n=== 2. 提取用户信息 ===");

const UserSchema = z.object({
  name: z.string().describe("用户姓名"),
  age: z.number().int().min(0).max(150).describe("用户年龄"),
  city: z.string().describe("所在城市"),
});

const userResult = await generateStructured({
  llm,
  messages: [{ role: "user", content: "我叫张三，今年 28 岁，住在北京" }],
  schema: UserSchema,
});
console.log("解析结果:", userResult.data);
console.log("尝试次数:", userResult.attempts);
console.log(
  "类型安全: name 是 string =",
  typeof userResult.data.name === "string",
);

// ─── 3. structuredChat（简化调用）──────────────────────────────
console.log("\n=== 3. structuredChat ===");

const SentimentSchema = z.object({
  text: z.string().describe("被分析的文本"),
  sentiment: z.enum(["positive", "negative", "neutral"]).describe("情感倾向"),
  confidence: z.number().min(0).max(1).describe("置信度 0-1"),
  keywords: z.array(z.string()).describe("关键词列表"),
});

const sentiment = await structuredChat(
  llm,
  "分析这句话的情感：这家餐厅的菜太难吃了，服务也很差！",
  SentimentSchema,
  { systemPrompt: "你是信息提取助手。从用户输入中提取结构化数据。" },
);
console.log("情感分析:", sentiment);

// ─── 4. 复杂嵌套结构 ───────────────────────────────────────────
console.log("\n=== 4. 复杂嵌套结构 ===");

const MeetingNotesSchema = z.object({
  title: z.string().describe("会议标题"),
  date: z.string().describe("会议日期"),
  participants: z.array(z.string()).describe("参会人员"),
  actionItems: z
    .array(
      z.object({
        task: z.string().describe("任务内容"),
        assignee: z.string().describe("指派给谁"),
        deadline: z.string().describe("截止日期"),
      }),
    )
    .describe("待办事项"),
});

const notes = await structuredChat(
  llm,
  `请从以下会议记录中提取结构化信息：
  2024年1月15日产品评审会，参会人：张三、李四、王五。
  待办：张三要在1月20日前完成API文档；李四要在1月25日前完成UI设计；王五要在1月30日前完成测试用例。`,
  MeetingNotesSchema,
  { systemPrompt: "你是信息提取助手。从用户输入中提取结构化数据。" },
);
console.log("会议纪要:", JSON.stringify(notes, null, 2));

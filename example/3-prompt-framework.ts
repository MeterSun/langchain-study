import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import { Agent } from "../src/core/agent.ts";
import {
  PromptTemplate,
  PromptStore,
  DynamicPrompt,
  VersionedPrompt,
} from "../src/core/prompt.ts";

// ─── 1. 基础模板 + 变量 ──────────────────────────────────────────
const greet = new PromptTemplate("你好，{{name}}！你今年 {{age}} 岁。");
console.log("=== 1. 基础模板 ===");
console.log(greet.render({ name: "Tom", age: 28 }));
console.log("inputVariables:", greet.inputVariables);

// ─── 2. Few-shot ─────────────────────────────────────────────────
const sentiment = new PromptTemplate(
  "分类以下句子的情感：{{text}}",
  {
    examples: [
      { input: "我今天很开心", output: "积极" },
      { input: "这部电影太烂了", output: "消极" },
      { input: "今天周三", output: "中性" },
    ],
  },
);
console.log("\n=== 2. Few-shot ===");
console.log(sentiment.render({ text: "天气真好啊" }));

// ─── 3. PromptStore ──────────────────────────────────────────────
const store = new PromptStore()
  .register("greet", greet)
  .register("sentiment", sentiment);
console.log("\n=== 3. PromptStore ===");
console.log("registered:", store.list());
console.log(store.render("greet", { name: "Jerry", age: 30 }));

// ─── 4. DynamicPrompt（按上下文切变体）────────────────────────────
const dynamic = new DynamicPrompt()
  .addVariant(
    "zh",
    new PromptTemplate("你是一个{{role}}。请用中文回答。"),
  )
  .addVariant(
    "en",
    new PromptTemplate("You are a {{role}}. Answer in English."),
  );
console.log("\n=== 4. DynamicPrompt ===");
console.log("variants:", dynamic.listVariants());
dynamic.use("en");
console.log(dynamic.render({ role: "translator" }));

// ─── 5. VersionedPrompt（多版本管理）──────────────────────────────
const versioned = new VersionedPrompt()
  .add("v1", new PromptTemplate("你是助手。"))
  .add("v2", new PromptTemplate("你是一个专业的{{domain}}助手。"));
console.log("\n=== 5. VersionedPrompt ===");
console.log("versions:", versioned.listVersions());
versioned.use("v2");
console.log(versioned.render({ domain: "法律" }));

// ─── 6. Agent 集成 ───────────────────────────────────────────────
const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL!,
  apiKey: process.env.OPENAI_API_KEY!,
});
const llm = new OpenAIModel(client, "deepseek-v4-flash");

const systemPrompt = new PromptTemplate(
  "你是一个{{style}}助手。用{{style}}的风格回答问题，控制在两句话以内。",
);

const agent = new Agent({ llm, systemPrompt });

console.log("\n=== 6. Agent 集成（幽默风格）===");
const funny = await agent.run("介绍一下 TypeScript", {
  promptVariables: { style: "幽默" },
});
console.log(funny);

console.log("\n=== 6b. Agent 集成（严肃风格）===");
const serious = await agent.run("介绍一下 TypeScript", {
  promptVariables: { style: "严肃" },
});
console.log(serious);

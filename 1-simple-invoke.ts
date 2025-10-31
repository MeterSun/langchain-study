/**
 * 1-simple-invoke.ts
 * 简单的调用模型
 */

import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  model: "deepseek-chat",
});

const result = await model.invoke([
  ["system", "Translate the following from English into Chinese"],
  ["human", "hi!"],
]);

console.log(result.content); // 你好!
console.log(result);

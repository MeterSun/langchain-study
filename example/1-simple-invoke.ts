// Please install OpenAI SDK first: `npm install openai`

import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY,
});

async function main() {
  const completion = await openai.chat.completions.create({
    messages: [{ role: "system", content: "你是一个专业的助手" }],
    // model: "deepseek-v4-pro",
    model: "deepseek-v4-flash",
    // thinking: { type: "enabled" },
    thinking: { type: "disabled" },
    // reasoning_effort: "high",
    stream: false,
  });

  console.log(JSON.stringify(completion, null, 2));
  console.log(completion.choices[0].message.content);
}

main();

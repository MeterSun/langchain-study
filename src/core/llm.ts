// Please install OpenAI SDK first: `npm install openai`

import OpenAI from "openai";

export class LLM {
  openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      baseURL: "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY,
    });
  }

  async chat(messages: string[]): Promise<string> {
    const completion = await this.openai.chat.completions.create({
      messages: messages.map((message) => ({ role: "user", content: message })),
      // model: "deepseek-v4-pro",
      model: "deepseek-v4-flash",
      // thinking: { type: "enabled" },
      thinking: { type: "disabled" },
      reasoning_effort: "high",
      stream: false,
    });

    return completion.choices[0].message.content;
  }
}

// new LLM().chat(["你好"]).then((response) => console.log(response));

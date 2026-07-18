import OpenAI from "openai";
import type { BaseLLM, ChatOptions } from "./base";
import { OpenAIModel } from "./openai";

export class Agent {
  llm: BaseLLM;
  constructor(params: { llm: BaseLLM }) {
    this.llm = params.llm;
  }
  chat(options: ChatOptions) {
    return this.llm.chat(options);
  }
}

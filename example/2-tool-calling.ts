import { z } from "zod";
import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import { Agent } from "../src/core/agent.ts";
import { defineTool } from "../src/core/tool.ts";

const client = new OpenAI({});

const llm = new OpenAIModel(client, "deepseek-v4-flash");

// 示例工具：模拟天气查询
const getWeather = defineTool({
  name: "get_weather",
  description: "获取指定城市的当前天气",
  parameters: z.object({
    city: z.string().describe("城市名，例如：北京"),
  }),
  execute: async ({ city }) => {
    const data: Record<string, string> = {
      北京: "晴，25°C，湿度 40%",
      上海: "多云，28°C，湿度 65%",
      广州: "雷阵雨，30°C，湿度 85%",
    };
    return data[city] ?? `未知城市：${city}`;
  },
});

const agent = new Agent({
  llm,
  tools: [getWeather],
  systemPrompt:
    "你是天气助手。需要查天气时调用 get_weather 工具，拿到结果后用自然语言回答用户。",
});

const answer = await agent.run("北京和上海今天天气怎么样？");
console.log("回答:", answer);

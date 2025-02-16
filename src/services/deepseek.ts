import dotenv from "dotenv";
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";

dotenv.config();
const { DEEPSEEK_KEY } = process.env;
if (!DEEPSEEK_KEY) console.error("DEEPSEEK_KEY environment variable is not set");

const Response = z.object({
  _toughts: z.string(),
  answer: z.string(),
});

interface Message {
  role: "system" | "user";
  content: string;
}

export class DeepSeek {
  private deepseek: OpenAI;

  constructor() {
    this.deepseek = new OpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey: DEEPSEEK_KEY
    });
    this.interact = this.interact.bind(this);
  }

  async interact(context: Array<Message>, model: string = "deepseek-chat", chainOfToughts: boolean = false): Promise<any> {
    try {
      const completion = await this.deepseek.chat.completions.create({
        model,
        messages: context,
        ...(chainOfToughts ? { response_format: zodResponseFormat(Response, "response") } : null),
      });

      return completion.choices[0].message;
    } catch (error: any) {
      console.error("DeepSeek Error:", (error as Error).message);

      throw error;
    }
  }

}
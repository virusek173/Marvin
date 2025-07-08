import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import dotenv from "dotenv";

dotenv.config();
const { GROK_API } = process.env;
if (!GROK_API) console.error("GROK_API environment variable is not set");

const Response = z.object({
  _toughts: z.string(),
  answer: z.string(),
});

export interface Message {
  role: "system" | "user";
  content: string;
}

export class OpenAi {
  private grok: OpenAI;

  constructor() {
    this.grok = new OpenAI({
      apiKey: GROK_API,
      baseURL: "https://api.x.ai/v1",
    });
    this.interact = this.interact.bind(this);
    this.contextInteract = this.contextInteract.bind(this);
  }

  async interact(
    userPrompt: string,
    model: string = "gpt-4o-mini",
    chainOfToughts: boolean = false
  ): Promise<any> {
    try {
      const context: Message[] = [
        {
          role: "system",
          content: "You are a helpful assistant.",
        },
        {
          role: "user",
          content: userPrompt,
        },
      ];
      const completion = await this.grok.chat.completions.create({
        model,
        messages: context,
        max_tokens: 2500,
        ...(chainOfToughts
          ? { response_format: zodResponseFormat(Response, "response") }
          : null),
      });

      return completion.choices[0].message;
    } catch (error: any) {
      console.error("GROK Error:", (error as Error).message);
      return null;
    }
  }

  async contextInteract(
    context: Array<Message>,
    model: string = "grok-3",
    chainOfToughts: boolean = false
  ): Promise<any> {
    try {
      console.log(">>>>>>>> context <<<<<<<<", model, context, context.length);
      const completion = await this.grok.chat.completions.create({
        model,
        messages: context,
        max_tokens: 2500,
        ...(chainOfToughts
          ? { response_format: zodResponseFormat(Response, "response") }
          : null),
      });

      return completion.choices[0].message;
    } catch (error: any) {
      console.error("GROK Error:", (error as Error).message);

      throw error;
    }
  }

  messageFactory(content: string, role: "user" | "system" = "user"): Message {
    return {
      role,
      content,
    };
  }
}

import "./propotypes.js";

import { Client, GatewayIntentBits } from "discord.js";
import {
  getFirstMotivionUserMessage,
  getMotivationSystemContext,
} from "./openai.js";

import dotenv from "dotenv";
import fs from "fs";
import {
  loadContextFromFile,
  messageResponseFactory,
  saveContextToFile,
} from "./helpers.js";
import { DeepSeek } from "./services/deepseek.js";
import { OpenAi } from "./services/openai.js";

const proxyHandler = {
  get(target: any, prop: any) {
    return target[prop] || prop || "";
  },
};

const mapGlobalNameNameToRealName = new Proxy(
  {
    Vajrusek: "Jacek",
    Crook: "Jacek",
    Odyn: "Madzia",
    magda1812: "Madzia",
    Hardik: "Domin",
    Dombear: "Domin",
    Zielarz: "Wiktor",
    Virzen: "Wiktor",
    Enczarko: "Basia",
    enczarko: "Basia",
    Grzerelli: "Grzegorz",
    grzerelli: "Grzegorz",
    luna03840: "Lena",
    Луна: "Lena",
    zoltymason: "Mason",
  },
  proxyHandler
);

dotenv.config();
const { MARVIN_ID, CLIENT_TOKEN, CHANNEL_ID } = process.env;
let context: Array<any> = [];

const DEFAULT_QUOTE = "Co żyje to żyje";
const deepseek = new DeepSeek();
const openai = new OpenAi();

export const discordMarvinInit = (
  client: any,
  date: string,
  _quote: string | undefined,
  personContext: string,
  withInitMessage: boolean = true
) => {
  const quote = _quote ? _quote : DEFAULT_QUOTE;
  client.on("ready", async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    const savedContext = loadContextFromFile("context.json");

    const systemContext = getMotivationSystemContext(date, MARVIN_ID);
    const firstUserMessage = getFirstMotivionUserMessage(quote);

    const channel = client.channels.cache.get(CHANNEL_ID);
    if (!withInitMessage) {
      channel.send(`Nie było mnie, ale wstałem z... Dockera.`);

      return;
    }
    try {
      const message = await openai.interact([
        ...systemContext,
        ...savedContext,
        ...firstUserMessage,
      ]);

      context = [message];
      channel.send(message.content);
    } catch (error: any) {
      console.log("err: ", error?.message);
      channel.send(
        `Wyjebałem się... POWÓD: ${error?.message?.substring(0, 1800)}
        Zapytaj mnie proszę ponownie.`
      );
    }
  });

  client.on("messageCreate", async (msg: any) => {
    if (
      msg.content.includes(MARVIN_ID) ||
      msg.mentions?.repliedUser?.username === "Marvin"
    ) {
      if (msg.author.username !== "Marvin") {
        msg.channel.sendTyping();

        const realName = mapGlobalNameNameToRealName[msg.author.globalName];
        const modifiedUserResponseContent = `${realName}: ${msg.content}`;
        const gptModel = true; //msg.content.toLowerCase().includes("gpt");
        const modelFunction = gptModel ? openai.interact : deepseek.interact;
        const messageAddition = `Z wyrazami szacunku,\nTwój model ${gptModel ? "GPT" : "DeepSeek"}.`;
        const userResponse = messageResponseFactory(
          modifiedUserResponseContent
        );

        context.pushWithLimit(userResponse);
        const systemContext = getMotivationSystemContext(date, MARVIN_ID);
        try {
          msg.channel.sendTyping();
          const assResponse = await modelFunction([
            ...systemContext,
            ...context,
          ]);
          if (assResponse) {
            context.pushWithLimit(assResponse);
          }
          const responseContent = `${assResponse.content}\n\n${messageAddition}`;
          msg.reply(
            responseContent.length < 2000
              ? responseContent
              : `${responseContent.substring(0, 1950)}...\n\n${messageAddition}`
          );

          saveContextToFile("context.json", context);
        } catch (error: any) {
          console.log("err: ", error?.message);

          msg.reply(
            `Wyjebałem się... POWÓD: ${error?.message?.substring(0, 1800)}
            Zapytaj mnie proszę ponownie.`
          );
        }
      }
    }
  });

  client.login(CLIENT_TOKEN);
};

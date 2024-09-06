import dotenv from "dotenv";
import { Client, GatewayIntentBits } from "discord.js";
import {
  openAiInteraction,
  getSystemContext,
  getInitWelcomeContext,
  getFirstUserMessage,
} from "./openai.js";
import "./propotypes.js";

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

const messageResponseFactory = (response: any) => ({
  role: "user",
  content: response,
});

export const discordMarvinInit = (
  client: any,
  date: string,
  holiday: string | undefined,
  withInitMessage: boolean = true
) => {
  if (!holiday) {
    console.log("Holiday undefined Error.");
    return null;
  }

  client.on("ready", async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    const systemContext = getSystemContext(date, holiday, MARVIN_ID);
    const firstUserMessage = getFirstUserMessage();

    if (!withInitMessage) return;
    const channel = client.channels.cache.get(CHANNEL_ID);
    try {
      const message = await openAiInteraction([
        ...systemContext,
        ...firstUserMessage,
      ]);

      context = [message];
      channel.send(message.content);
    } catch (error: any) {
      console.log("err: ", error?.message);
      channel.send(
        `Wyjebałem się... POWÓD: ${error?.message?.substring(0, 1800)}`
      );
    }
  });

  client.on("messageCreate", async (msg: any) => {
    if (msg.content.includes(MARVIN_ID)) {
      if (msg.author.username !== "Marvin") {
        const realName = mapGlobalNameNameToRealName[msg.author.globalName];
        const modifiedUserResponseContent = `${realName}: ${msg.content}`;
        const userResponse = messageResponseFactory(
          modifiedUserResponseContent
        );

        context.pushWithLimit(userResponse);
        const systemContext = getSystemContext(date, holiday, MARVIN_ID);
        try {
          const assResponse = await openAiInteraction([
            ...systemContext,
            ...context,
          ]);
          context.pushWithLimit(assResponse);
          msg.reply(assResponse.content);
        } catch (error: any) {
          console.log("err: ", error?.message);

          msg.reply(
            `Wyjebałem się... POWÓD: ${error?.message?.substring(0, 1800)}`
          );
        }
      }
    }
  });

  client.login(CLIENT_TOKEN);
};

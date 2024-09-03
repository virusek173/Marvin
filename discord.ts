import dotenv from "dotenv";
import { Client, GatewayIntentBits } from "discord.js";
import {
  openAiInteraction,
  getInitContext,
  getInitWelcomeContext,
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
let systemContext: Array<any> = [];

const messageResponseFactory = (response: any) => ({
  role: "user",
  content: response,
});

export const discordMarvinInit = (
  client: any,
  holiday: string | undefined,
  withInitMessage: boolean = true
) => {
  if (!holiday) {
    console.log("Holiday undefined Error.");
    return null;
  }

  client.on("ready", async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    systemContext = getInitContext(holiday, MARVIN_ID);
    if (!withInitMessage) return;
    const channel = client.channels.cache.get(CHANNEL_ID);
    const message = await openAiInteraction(systemContext);
    context = [message];
    systemContext.pop();

    channel.send(message.content);
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
        const assResponse = await openAiInteraction([
          ...systemContext,
          ...context,
        ]);
        context.pushWithLimit(assResponse);
        msg.reply(assResponse.content);
      }
    }
  });

  client.login(CLIENT_TOKEN);
};

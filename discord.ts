import "./propotypes.js";

import { Client, GatewayIntentBits } from "discord.js";
import {
  getFirstUserMessage,
  getInitWelcomeContext,
  getSystemContext,
  openAiInteraction,
} from "./openai.js";

import dotenv from "dotenv";

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
  _holiday: string | undefined,
  personContext: string,
  withInitMessage: boolean = true
) => {
  const holiday = _holiday ? _holiday : "Brak święta";
  client.on("ready", async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    const systemContext = getSystemContext(
      date,
      holiday,
      MARVIN_ID,
      personContext
    );
    const firstUserMessage = getFirstUserMessage();

    const channel = client.channels.cache.get(CHANNEL_ID);
    if (!withInitMessage) {
      channel.send(`Dzień dobry! Nie było mnie, ale wstałem...`);

      return;
    }
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
        const realName = mapGlobalNameNameToRealName[msg.author.globalName];
        const modifiedUserResponseContent = `${realName}: ${msg.content}`;
        const userResponse = messageResponseFactory(
          modifiedUserResponseContent
        );

        context.pushWithLimit(userResponse);
        const systemContext = getSystemContext(
          date,
          holiday,
          MARVIN_ID,
          personContext
        );
        try {
          const assResponse = await openAiInteraction([
            ...systemContext,
            ...context,
          ]);
          context.pushWithLimit(assResponse);
          msg.reply(
            assResponse.content.length < 2000
              ? assResponse.content
              : `${assResponse.content.substring(0, 1950)}...`
          );
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

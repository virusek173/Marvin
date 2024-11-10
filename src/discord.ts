import "./propotypes.js";

import { Client, GatewayIntentBits } from "discord.js";
import {
  getFirstExperimentalUserMessage,
  getInitWelcomeContext,
  getExperimentalSystemContext,
  openAiInteraction,
} from "./openai.js";

import dotenv from "dotenv";
import fs from "fs";

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

const loadContextFromFile = (fileName: string): Array<any> => {
  try {
    if (fs.existsSync(fileName)) {
      const contextData = fs.readFileSync(fileName, 'utf8');
      context = JSON.parse(contextData);
      return context;
    }
    return [];
  } catch (error) {
    console.error('Error reading context file:', error);
    return [];
  }
};

const saveContextToFile = (fileName: string, context: Array<any>): void => {
  try {
    const contextJson = JSON.stringify(context, null, 2);
    fs.writeFileSync(fileName, contextJson);
  } catch (error) {
    console.error('Error writing context file:', error);
  }
};

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
    
    const savedContext = loadContextFromFile('context.json');

    const systemContext = getExperimentalSystemContext(
      date,
      holiday,
      MARVIN_ID,
    );
    const firstUserMessage = getFirstExperimentalUserMessage();

    const channel = client.channels.cache.get(CHANNEL_ID);
    if (!withInitMessage) {
      channel.send(`Nie było mnie, ale wstałem z... Dockera.`);

      return;
    }
    try {
      const message = await openAiInteraction([
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
        const userResponse = messageResponseFactory(
          modifiedUserResponseContent
        );

        context.pushWithLimit(userResponse);
        const systemContext = getExperimentalSystemContext(
          date,
          holiday,
          MARVIN_ID,
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

          saveContextToFile('context.json', context);
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

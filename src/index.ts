import { getFormattedDateForPrompt, getTodayDate } from "./helpers.js";
import { discordMarvinInit } from "./discord.js";
import cron from "node-cron";
import { Client, GatewayIntentBits } from "discord.js";
import { getQuote } from "./openai.js";

let client: any = null;

const croneMap = {
  SIX_AM: "0 6 * * *",
};

const croneOptions = {
  timezone: "Europe/Warsaw",
};

const init = async (withInitMessage: boolean | undefined = true) => {
  try {
    const date = await getTodayDate();
    console.log("Today's date: ", date);
    if (client) client.destroy();
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    });
    const quote = await getQuote();
    console.log("Today's quote: ", quote);
    discordMarvinInit(client, date, quote, "", withInitMessage);
  } catch (error: any) {
    console.log("Unexpected Error: ", error?.message);
  }
};

init(false);

const croneTime = croneMap.SIX_AM;

console.log(`Uruchamiam crone z czasem: ${croneTime}`);
cron.schedule(croneTime, () => init(), croneOptions);

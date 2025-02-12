import { discordMarvinInit } from "./discord.js";
import cron from "node-cron";
import { DateService } from "./services/date.js";
import { ClientService } from "./services/client.js";
import { OpenAi } from "./services/openai.js";
import { QUOTE_PROMPT } from "./prompts.js";

const openai = new OpenAi();
const croneMap = {
  SIX_AM: "0 6 * * *",
};

const croneOptions = {
  timezone: "Europe/Warsaw",
};

const init = async (withInitMessage: boolean | undefined = true) => {
  try {
    const date = new DateService();
    const formattedDate = date.getFormattedDate();
    const client = new ClientService();
    const quote = await openai.interact(QUOTE_PROMPT, "gpt-4o")
    console.log("Today's quote: ", quote);
    discordMarvinInit(client.getClient(), formattedDate, quote, "", withInitMessage);
  } catch (error: any) {
    console.log("Unexpected Error: ", error?.message);
  }
};

init(false);

const croneTime = croneMap.SIX_AM;

console.log(`Uruchamiam crone z czasem: ${croneTime}`);
cron.schedule(croneTime, () => init(), croneOptions);

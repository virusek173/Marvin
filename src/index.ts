import cron from "node-cron";
import { OpenAi } from "./services/openai.js";
import { QUOTE_PROMPT } from "./prompts.js";
import { DiscordServce } from "./services/discord.js";

const openai = new OpenAi();
const croneMap = {
  SIX_AM: "0 6 * * *",
};
const croneOptions = {
  timezone: "Europe/Warsaw",
};
const WITH_INIT_MESSAGE = true;

const init = async (withInitMessage: boolean | undefined = true) => {
  try {
    const quote = await openai.interact(QUOTE_PROMPT, "gpt-4o")
    new DiscordServce(quote, withInitMessage);
  } catch (error: any) {
    console.log("Unexpected Error: ", error?.message);
  }
};

init(WITH_INIT_MESSAGE);

const croneTime = croneMap.SIX_AM;

console.log(`Uruchamiam crone z czasem: ${croneTime}`);
cron.schedule(croneTime, () => init(), croneOptions);

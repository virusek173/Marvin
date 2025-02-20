import cron from "node-cron";
import { OpenAi } from "./services/openai.js";
import { QUOTE_PROMPT } from "./utils/prompts.js";
import { DiscordServce } from "./services/discord.js";

const openai = new OpenAi();
const croneMap = {
  EVERY_DAY_SIX_AM: "0 6 * * *",
  EVERY_MINUTE: "* * * * *",
};
const croneOptions = {
  timezone: "Europe/Warsaw",
};
const WITH_INIT_MESSAGE = false;
let client: any = null;

const init = async (withInitMessage: boolean | undefined = true) => {
  try {
    client?.destroy();
    const quote = await openai.interact(QUOTE_PROMPT, "gpt-4o")
    client = new DiscordServce(quote, withInitMessage);
  } catch (error: any) {
    console.log("Unexpected Error: ", error?.message);
  }
};

init(WITH_INIT_MESSAGE);

const croneTime = croneMap.EVERY_DAY_SIX_AM;

console.log(`Uruchamiam crone z czasem: ${croneTime}`);
cron.schedule(croneTime, () => init(), croneOptions);

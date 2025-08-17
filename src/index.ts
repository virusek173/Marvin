import cron from "node-cron";
import { OpenAi } from "./services/openai.js";
import { DiscordServce } from "./services/discord.js";
import { QUOTE_MODEL_NAME } from "./utils/consts.js";
import { pushWithLimit, quotePromptFactory } from "./utils/helpers.js";

const quotesArray: string[] = [];
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
    const quotePro = quotePromptFactory(quotesArray);
    const quote = await openai.interact(quotePromptFactory(quotesArray), QUOTE_MODEL_NAME)
    pushWithLimit(quotesArray, quote?.content);
    client = new DiscordServce(quote?.content, withInitMessage);
  } catch (error: any) {
    console.log("Unexpected Error: ", error?.message);
  }
};

init(WITH_INIT_MESSAGE);

const croneTime = croneMap.EVERY_DAY_SIX_AM;

console.log(`Uruchamiam crone z czasem: ${croneTime}`);
cron.schedule(croneTime, () => init(), croneOptions);

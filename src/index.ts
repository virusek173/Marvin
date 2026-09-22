import cron from "node-cron";
import dotenv from "dotenv";
import * as fs from "fs";
import { OpenAi } from "./services/openai.js";
import { DiscordServce } from "./services/discord.js";
import { QUOTE_MODEL_NAME } from "./utils/consts.js";
import { pushWithLimit, quotePromptFactory } from "./utils/helpers.js";

dotenv.config();

const DATA_DIR = "data";
fs.mkdirSync(DATA_DIR, { recursive: true });
const LAST_SUMMARY_FILE = `${DATA_DIR}/last_summary.json`;

const quotesArray: string[] = [];
const openai = new OpenAi();
const croneMap = {
  EVERY_DAY_SIX_AM: "0 6 * * *",
  EVERY_DAY_EIGHT_PM: "0 20 * * *",
  EVERY_MINUTE: "* * * * *",
};
const croneOptions = {
  timezone: "Europe/Warsaw",
};
const WITH_INIT_MESSAGE = false;
const WITH_CRON = process.env.WITH_CRON !== "false";
const SERVER_SUMMARY_INTERVAL_DAYS = 2;

let client: any = null;

const readLastSummaryAt = (): Date | null => {
  try {
    if (fs.existsSync(LAST_SUMMARY_FILE)) {
      const { lastSummaryAt } = JSON.parse(fs.readFileSync(LAST_SUMMARY_FILE, "utf8"));
      return lastSummaryAt ? new Date(lastSummaryAt) : null;
    }
  } catch (error) {
    console.error("Error reading last summary file:", error);
  }
  return null;
};

const writeLastSummaryAt = (date: Date): void => {
  try {
    fs.writeFileSync(LAST_SUMMARY_FILE, JSON.stringify({ lastSummaryAt: date.toISOString() }, null, 2));
  } catch (error) {
    console.error("Error writing last summary file:", error);
  }
};

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

if (WITH_CRON) {
  console.log(`Uruchamiam crone z czasem: ${croneTime}`);
  cron.schedule(croneTime, () => init(), croneOptions);
} else {
  console.log("Cron wyłączony (WITH_CRON=false).");
}

console.log(`Uruchamiam podsumowanie serwera co ${SERVER_SUMMARY_INTERVAL_DAYS} dni.`);
cron.schedule(croneMap.EVERY_DAY_EIGHT_PM, () => {
  const lastSummaryAt = readLastSummaryAt();
  if (!lastSummaryAt) {
    writeLastSummaryAt(new Date());
    return;
  }
  const daysSinceLastSummary = (Date.now() - lastSummaryAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceLastSummary >= SERVER_SUMMARY_INTERVAL_DAYS) {
    writeLastSummaryAt(new Date());
    client?.sendServerSummary();
  }
}, croneOptions);

import cron from "node-cron";
import dotenv from "dotenv";
import * as fs from "fs";
import { DiscordServce } from "./services/discord.js";

dotenv.config();

const DATA_DIR = "data";
fs.mkdirSync(DATA_DIR, { recursive: true });
const LAST_SUMMARY_FILE = `${DATA_DIR}/last_summary.json`;

const croneMap = {
  EVERY_DAY_EIGHT_PM: "0 20 * * *",
  EVERY_DAY_FOUR_AM: "0 4 * * *",
};
const croneOptions = {
  timezone: "Europe/Warsaw",
};
const DEFAULT_SERVER_SUMMARY_INTERVAL_DAYS = 3;
const configuredInterval = Number(process.env.SERVER_SUMMARY_INTERVAL_DAYS);
const SERVER_SUMMARY_INTERVAL_DAYS = configuredInterval > 0 ? configuredInterval : DEFAULT_SERVER_SUMMARY_INTERVAL_DAYS;

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

try {
  client = new DiscordServce();
} catch (error: any) {
  console.log("Unexpected Error: ", error?.message);
}

const roundToMinute = (ms: number): number => Math.round(ms / 60000) * 60000;

console.log(`Uruchamiam podsumowanie serwera co ${SERVER_SUMMARY_INTERVAL_DAYS} dni.`);
cron.schedule(croneMap.EVERY_DAY_FOUR_AM, () => {
  client?.updateProfiles();
}, croneOptions);
cron.schedule(croneMap.EVERY_DAY_EIGHT_PM, () => {
  const lastSummaryAt = readLastSummaryAt();
  if (!lastSummaryAt) {
    writeLastSummaryAt(new Date());
    return;
  }
  const daysSinceLastSummary = (roundToMinute(Date.now()) - roundToMinute(lastSummaryAt.getTime())) / (1000 * 60 * 60 * 24);
  if (daysSinceLastSummary >= SERVER_SUMMARY_INTERVAL_DAYS) {
    writeLastSummaryAt(new Date());
    client?.sendServerSummary(lastSummaryAt);
  }
}, croneOptions);

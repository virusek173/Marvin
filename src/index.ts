import cron from "node-cron";
import dotenv from "dotenv";
import * as fs from "fs";
import { DiscordServce } from "./services/discord.js";
import { previousMonth, warsawDayOfMonth } from "./services/history/report.js";

dotenv.config();

const DATA_DIR = "data";
fs.mkdirSync(DATA_DIR, { recursive: true });
const LAST_SUMMARY_FILE = `${DATA_DIR}/last_summary.json`;
const LAST_REPORT_FILE = `${DATA_DIR}/last_report.json`;

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
const readLastReportMonth = (): string | null => {
  try {
    if (fs.existsSync(LAST_REPORT_FILE)) return JSON.parse(fs.readFileSync(LAST_REPORT_FILE, "utf8")).lastReportMonth ?? null;
  } catch (error) {
    console.error("Error reading last report file:", error);
  }
  return null;
};

const writeLastReportMonth = (month: string): void => {
  try {
    fs.writeFileSync(LAST_REPORT_FILE, JSON.stringify({ lastReportMonth: month }, null, 2));
  } catch (error) {
    console.error("Error writing last report file:", error);
  }
};

// Sends the report for the previous month once. The first run only records a baseline unless it is the 1st, so enabling the
// report mid-month does not post at once; after downtime on the 1st the missed report goes out on the next 20:00.
const sendMonthlyReportIfDue = (): void => {
  if (process.env.MONTHLY_REPORT_ENABLED !== "true") return;
  const month = previousMonth(Date.now());
  const last = readLastReportMonth();
  if (last === null && warsawDayOfMonth(Date.now()) !== 1) {
    writeLastReportMonth(month.key);
    return;
  }
  if (last !== null && last >= month.key) return;
  writeLastReportMonth(month.key);
  void client?.sendMonthlyReport(month);
};

cron.schedule(croneMap.EVERY_DAY_EIGHT_PM, () => {
  sendMonthlyReportIfDue();
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

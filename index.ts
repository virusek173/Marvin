import { getTodayHoliday } from "./helpers.js";
import { discordMarvinInit } from "./discord.js";
import cron from "node-cron";
import { Client, GatewayIntentBits } from "discord.js";

let client: any = null;

const croneMap = {
  SIX_AM: "0 6 * * *",
};

const init = async (withInitMessage: boolean | undefined = true) => {
  try {
    const holiday = getTodayHoliday();
    console.log("Today's holiday: ", holiday);
    if (client) client.destroy();
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    });
    discordMarvinInit(client, holiday, withInitMessage);
  } catch (error: any) {
    console.log("Unexpected Error: ", error?.message);
  }
};

init(false);

const croneTime = croneMap.SIX_AM;

console.log(`Uruchamiam crone z czasem: ${croneTime}`);
cron.schedule(croneTime, () => init());

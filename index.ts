import { getTodayHoliday } from "./helpers.js";
import { initMarvin } from "./marvin.js";

try {
  const holiday = getTodayHoliday();
  console.log("Today's holiday: ", holiday);

  await initMarvin(holiday);
} catch (error: any) {
  console.log("Unexpected Error: ", error?.message);
}

import { holidayData } from "./data.js";
import { HolidayObject } from "./model.js";

export const getFormattedDate = (today: Date): string => {
  var mm = today.getMonth() + 1;
  var dd = today.getDate();

  return [(mm > 9 ? "" : "0") + mm, (dd > 9 ? "" : "0") + dd].join("");
};

export const getHolidayOfTheDay = (
  day: string,
  holidayData: Array<HolidayObject>
): string | undefined => {
  const holidayObject = Object.values(holidayData).find((o) => o.date === day);

  return holidayObject?.holiday;
};

export const getHolidayData = () => holidayData;

export const getTodayHoliday = (): string | undefined => {
  const today = new Date();
  const todayString = getFormattedDate(today);
  const holidayData = getHolidayData();

  return getHolidayOfTheDay(todayString, holidayData);
};

import { holidayObject } from "./data.js";
import { HolidayObject } from "./model.js";

export const getFormattedDate = (today: Date): string => {
  var mm = today.getMonth() + 1;
  var dd = today.getDate();

  return [(mm > 9 ? "" : "0") + mm, (dd > 9 ? "" : "0") + dd].join("");
};

export const getHolidayOfTheDay = (
  day: string,
  _holidayObject: HolidayObject
): string | undefined => {
  const holiday = _holidayObject[day];

  return holiday;
};

export const getHolidayData = (): HolidayObject => holidayObject;

export const getTodayHoliday = (): string | undefined => {
  const today = new Date();
  const todayString = getFormattedDate(today);
  const _holidayObject = getHolidayData();

  return getHolidayOfTheDay(todayString, _holidayObject);
};

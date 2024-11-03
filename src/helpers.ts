import { HolidayObject } from "./model.js";

export const getFormattedDate = (today: Date): string => {
  var mm = today.getMonth() + 1;
  var dd = today.getDate();

  return [(mm > 9 ? "" : "0") + mm, (dd > 9 ? "" : "0") + dd].join("");
};

export const getFormattedDateForPrompt = (today: Date): string => {
  var rr = today.getFullYear();
  var mm = today.getMonth() + 1;
  var dd = today.getDate();

  return [rr, (mm > 9 ? "" : "0") + mm, (dd > 9 ? "" : "0") + dd].join(".");
};

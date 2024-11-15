import { HolidayObject } from "./model.js";
import * as fs from "fs";

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

export const loadContextFromFile = (fileName: string): Array<any> => {
  try {
    if (fs.existsSync(fileName)) {
      const contextData = fs.readFileSync(fileName, "utf8");
      const context = JSON.parse(contextData);
      return context;
    }
    return [];
  } catch (error) {
    console.error("Error reading context file:", error);
    return [];
  }
};

export const saveContextToFile = (
  fileName: string,
  context: Array<any>
): void => {
  try {
    const contextJson = JSON.stringify(context, null, 2);
    fs.writeFileSync(fileName, contextJson);
  } catch (error) {
    console.error("Error writing context file:", error);
  }
};

export const messageResponseFactory = (response: any) => ({
  role: "user",
  content: response,
});

export const getTodayDate = async () => {
  const today = new Date();

  return getFormattedDateForPrompt(today);
};

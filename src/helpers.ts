import { HolidayObject } from "./model.js";
import * as fs from "fs";

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


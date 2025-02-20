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

export const proxyHandler = {
  get(target: any, prop: any) {
    return target[prop] || prop || "";
  },
};

export const mapGlobalNameNameToRealName = new Proxy(
  {
    Vajrusek: "Jacek",
    Crook: "Jacek",
    Odyn: "Madzia",
    magda1812: "Madzia",
    Hardik: "Domin",
    Dombear: "Domin",
    Zielarz: "Wiktor",
    Virzen: "Wiktor",
    Enczarko: "Basia",
    enczarko: "Basia",
    Grzerelli: "Grzegorz",
    grzerelli: "Grzegorz",
    luna03840: "Lena",
    Луна: "Lena",
    zoltymason: "Mason",
  },
  proxyHandler
);

export const exceptionHandler = (error: any, message: any) => {
  console.log("err: ", error?.message);

  message.reply(
    `Wyjebałem się... POWÓD: ${error?.message?.substring(0, 1800)}
    Zapytaj mnie proszę ponownie.`
  );
}

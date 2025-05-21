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

  message.reply?.(
    `Wywaliłem się... POWÓD: ${error?.message?.substring(0, 1800)}
    Zapytaj mnie proszę ponownie.`
  );
}

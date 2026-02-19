import { QUOTE_PROMPT } from "./prompts.js";

/** Proxy handler that returns the property value, the property name, or empty string as fallback. */
export const proxyHandler = {
  get(target: any, prop: any) {
    return target[prop] || prop || "";
  },
};

/**
 * Maps Discord global usernames to real first names used in conversation context.
 * If the username is not in the map, the Proxy returns the username itself as fallback.
 * Add new entries here when a team member joins or changes their Discord username.
 */
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

/**
 * Handles errors from AI service calls by logging and replying to the Discord message.
 * Safe to call when `message` is either a Discord Message or a Channel object.
 */
export const exceptionHandler = (error: any, message: any) => {
  console.log("err: ", error?.message);

  message.reply?.(
    `Wywaliłem się... POWÓD: ${error?.message?.substring(0, 1800)}
    Zapytaj mnie proszę ponownie.`
  );
}

/**
 * Adds an item to an array while keeping it within a maximum size (FIFO).
 * If the array is at capacity, removes the oldest item before pushing.
 * Ignores null/undefined items (does not push them).
 *
 * @param array - The mutable array to push into
 * @param item - Item to add (null/undefined are skipped)
 * @param limit - Maximum array size (default: 10). For context windows use ContextService which defaults to 30.
 */
export const pushWithLimit = (array: any[], item: any, limit: number = 10) => {
  if (array.length >= limit) {
    array.shift();
  }

  item && array.push(item);
  return array;
};


/**
 * Builds a prompt for generating a motivational quote that differs from previous ones.
 * Pass the `quotesArray` from index.ts (kept at max 10 entries via pushWithLimit).
 *
 * @param quotesArray - Array of previously used quotes to avoid repetition
 */
export const quotePromptFactory = (quotesArray: string[]) => `${QUOTE_PROMPT}
Cytat musi się różnić od podanych cytatów.
Poprzednie cytaty: ${quotesArray.join("\n,")}`;
import { IMAGE_LAZY_REPLIES } from "../../utils/prompts.js";

export const ERROR_MESSAGE_PREFIX = "Wywaliłem się...";
export const INTERNET_NOTICE = "To pytanie mnie przerosło. \nZaglądam do Internetu. 🌐";
// No longer sent; kept so notices already in the archive are still recognised as technical.
export const linksNotice =(count: number): string => `Zaglądam do ${count > 1 ? "linków" : "linka"}. 🔗`;

const FIXED_NOTICES = new Set<string>([
    ...IMAGE_LAZY_REPLIES,
    INTERNET_NOTICE,
    linksNotice(1),
    linksNotice(2),
]);

/** True for Marvin's fixed status phrases that must not enter the model's conversation context. */
export const isTechnicalMarvinContent = (content: string): boolean => {
    const text = (content ?? "").trim();
    return FIXED_NOTICES.has(text) || text.startsWith(ERROR_MESSAGE_PREFIX);
};

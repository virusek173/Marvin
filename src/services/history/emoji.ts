const CUSTOM_EMOJI = /<a?:(\w+):\d+>/g;
const CUSTOM_EMOJI_ONLY = /^<a?:(\w+):\d+>$/;
const SHORTCODE = /^:?(\w+):?$/;

const MODIFIERS = "(?:\\p{Emoji_Modifier}|\\uFE0F)*";
const PICTOGRAPH = "(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)";
// A pictograph is an emoji when it is drawn as one by default or carries the emoji variation selector, so plain ©, ® or ™ are not counted.
const UNICODE_EMOJI = new RegExp(
    `\\p{Regional_Indicator}{2}|${PICTOGRAPH}${MODIFIERS}(?:\\u200D(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic})${MODIFIERS})*`,
    "gu"
);

/** One key per emoji: `:name:` for a server emoji, otherwise the character without skin tone and variation selector. */
const normalizeUnicode = (emoji: string): string => emoji.replace(/\p{Emoji_Modifier}|️/gu, "");

export const customEmojiKey = (name: string): string => `:${name}:`;

export const unicodeEmojiKey = (emoji: string): string => normalizeUnicode(emoji);

/** Emoji used in a message text (server emoji and Unicode emoji) with the number of uses of each. */
export const extractEmoji = (content: string): Map<string, number> => {
    const found = new Map<string, number>();
    const add = (key: string) => found.set(key, (found.get(key) ?? 0) + 1);
    if (!content) return found;
    const withoutCustom = content.replace(CUSTOM_EMOJI, (_, name: string) => {
        add(customEmojiKey(name));
        return " ";
    });
    for (const match of withoutCustom.matchAll(UNICODE_EMOJI)) add(unicodeEmojiKey(match[0]));
    return found;
};

/** Turns what the model passes as an emoji (😂, :pepe:, pepe, <:pepe:123>) into the stored key, or null when it is not one. */
export const emojiKeyFromInput = (input: string): string | null => {
    const text = input.trim();
    const custom = CUSTOM_EMOJI_ONLY.exec(text);
    if (custom) return customEmojiKey(custom[1]);
    const shortcode = SHORTCODE.exec(text);
    if (shortcode) return customEmojiKey(shortcode[1]);
    const first = text.match(UNICODE_EMOJI)?.[0] ?? (text.length > 0 && /\p{Extended_Pictographic}/u.test(text) ? text.match(/\p{Extended_Pictographic}/u)![0] : null);
    return first ? unicodeEmojiKey(first) : null;
};

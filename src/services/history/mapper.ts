import { isTechnicalMarvinContent } from "./technical.js";

export interface ArchiveRow {
    id: string;
    channelId: string;
    parentId: string | null;
    authorId: string;
    authorName: string;
    isBot: boolean;
    content: string;
    embedsText: string;
    attachmentsText: string;
    replyToId: string | null;
    type: number;
    isTechnical: boolean;
    createdAt: number;
}

export interface MapOptions {
    selfId?: string;
    selfUsername?: string;
    /** One description per image attachment, in attachment order. Missing = backfill marker. */
    imageDescriptions?: string[];
}

const isImage = (att: any): boolean => !!att?.contentType?.startsWith("image/");

export const formatImageDescriptions = (descriptions: string[]): string =>
    descriptions
        .map((desc, i) => (descriptions.length > 1 ? `[Obraz ${i + 1}: ${desc}]` : `[Obraz: ${desc}]`))
        .join(" ");

/** Humans' link previews are noise (title only); bots often put their whole reply in an embed. */
export const flattenEmbeds = (embeds: any[] | undefined, authorIsBot: boolean): string =>
    (embeds ?? [])
        .map((e: any) =>
            authorIsBot
                ? [e?.title, e?.description, ...(e?.fields ?? []).map((f: any) => `${f?.name}: ${f?.value}`)]
                      .filter(Boolean)
                      .join("\n")
                : (e?.title ?? "")
        )
        .filter(Boolean)
        .join("\n");

export const describeAttachments = (message: any, imageDescriptions?: string[]): string => {
    const attachments: any[] = [...(message?.attachments?.values() ?? [])];
    const images = attachments.filter(isImage);
    const parts: string[] = [];

    if (images.length > 0) {
        const descriptions = images.map((att, i) => imageDescriptions?.[i] ?? `nieopisany, plik ${att.name ?? "?"}`);
        parts.push(formatImageDescriptions(descriptions));
    }
    for (const att of attachments.filter(a => !isImage(a))) {
        parts.push(`[Załącznik: ${att.name ?? "?"}${att.contentType ? ` (${att.contentType})` : ""}]`);
    }
    return parts.join(" ");
};

export const buildArchiveRow = (message: any, options: MapOptions = {}): ArchiveRow => {
    const { selfId, selfUsername, imageDescriptions } = options;
    const author = message.author;
    const isSelf = (!!selfId && author.id === selfId) || (!!selfUsername && author.username === selfUsername);
    const channel = message.channel;
    const isThread = typeof channel?.isThread === "function" && channel.isThread();
    const content: string = message.content ?? "";

    return {
        id: message.id,
        channelId: message.channelId,
        parentId: isThread ? (channel.parentId ?? null) : null,
        authorId: author.id,
        authorName: author.globalName || author.username || "",
        isBot: !!author.bot,
        content,
        embedsText: flattenEmbeds(message.embeds, !!author.bot),
        attachmentsText: describeAttachments(message, imageDescriptions),
        replyToId: message.reference?.messageId ?? null,
        type: Number(message.type ?? 0),
        isTechnical: isSelf && isTechnicalMarvinContent(content),
        createdAt: message.createdTimestamp ?? new Date(message.createdAt).getTime(),
    };
};

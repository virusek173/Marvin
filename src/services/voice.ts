import axios from "axios";
import { isVoiceAttachment } from "./history/mapper.js";

export const MAX_VOICE_SECONDS = 300;
const MAX_VOICE_BYTES = 25 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 3000;
const DISCORD_CDN_HOST = /(^|\.)discordapp\.(com|net)$/;

export type Transcribe = (audio: Buffer, filename: string, contentType: string) => Promise<string>;
export type Download = (url: string) => Promise<Buffer>;

const downloadAttachment: Download = async url => {
    const response = await axios.get(url, { responseType: "arraybuffer", timeout: 20000, maxContentLength: MAX_VOICE_BYTES, maxRedirects: 0 });
    return Buffer.from(response.data);
};

const clip = (text: string): string => (text.length > MAX_TRANSCRIPT_CHARS ? `${text.slice(0, MAX_TRANSCRIPT_CHARS)}…` : text);

export interface VoiceOutcome {
    /** The transcript, or a bracketed marker saying why there is none. */
    text: string;
    /** True when a retry later may succeed (download or API failure); false for final outcomes. */
    transient: boolean;
}

export async function transcribeVoiceAttachment(att: any, transcribe: Transcribe, download: Download = downloadAttachment): Promise<VoiceOutcome> {
    try {
        if (att.duration > MAX_VOICE_SECONDS) return { text: `[za długa, ${Math.round(att.duration)} s, nie przepisana]`, transient: false };
        if (att.size > MAX_VOICE_BYTES) return { text: "[za duży plik, nie przepisana]", transient: false };
        if (!DISCORD_CDN_HOST.test(new URL(att.url).hostname)) return { text: "[nie udało się przepisać]", transient: false };
        const text = (await transcribe(await download(att.url), att.name ?? "voice-message.ogg", att.contentType ?? "audio/ogg")).trim();
        return { text: text ? clip(text) : "[cisza lub brak mowy]", transient: false };
    } catch (error: any) {
        console.error("[voice] transkrypcja nie powiodła się:", error?.message);
        return { text: "[nie udało się przepisać]", transient: true };
    }
}

/** One transcript (or a short marker saying why there is none) per voice-message attachment; empty array when the message has none. */
export async function transcribeVoiceMessages(message: any, transcribe: Transcribe, download: Download = downloadAttachment): Promise<string[]> {
    const voices = [...(message?.attachments?.values() ?? [])].filter(isVoiceAttachment);
    return Promise.all(voices.map(async att => (await transcribeVoiceAttachment(att, transcribe, download)).text));
}

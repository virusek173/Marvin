import { transcribeVoiceMessages, MAX_VOICE_SECONDS } from "../voice";
import { buildArchiveRow, describeAttachments, isVoiceAttachment } from "../history/mapper";

const voice = (over: Record<string, unknown> = {}) => ({
    id: "1",
    name: "voice-message.ogg",
    contentType: "audio/ogg",
    duration: 7.2,
    size: 20000,
    url: "https://cdn.discordapp.com/attachments/1/2/voice-message.ogg?ex=1",
    ...over,
});
const msgWith = (...atts: any[]) => ({ attachments: new Map(atts.map((a, i) => [String(i), a])) });

describe("transcribeVoiceMessages", () => {
    const download = jest.fn(async () => Buffer.from("audio"));
    const transcribe = jest.fn(async () => "  Cześć, jutro o ósmej.  ");
    beforeEach(() => { download.mockClear(); transcribe.mockClear(); });

    it("transcribes a voice message from the Discord CDN", async () => {
        expect(await transcribeVoiceMessages(msgWith(voice()), transcribe, download)).toEqual(["Cześć, jutro o ósmej."]);
        expect(download).toHaveBeenCalledWith(voice().url);
        expect(transcribe).toHaveBeenCalledWith(Buffer.from("audio"), "voice-message.ogg", "audio/ogg");
    });

    it("ignores images and plain audio files (no duration)", async () => {
        const result = await transcribeVoiceMessages(msgWith({ contentType: "image/png", url: "https://cdn.discordapp.com/a.png" }, voice({ duration: undefined })), transcribe, download);
        expect(result).toEqual([]);
        expect(download).not.toHaveBeenCalled();
    });

    it("skips too long recordings without downloading", async () => {
        const [text] = await transcribeVoiceMessages(msgWith(voice({ duration: MAX_VOICE_SECONDS + 1 })), transcribe, download);
        expect(text).toMatch(/za długa/);
        expect(download).not.toHaveBeenCalled();
    });

    it("refuses URLs outside the Discord CDN", async () => {
        const [text] = await transcribeVoiceMessages(msgWith(voice({ url: "https://evil.example.com/a.ogg" })), transcribe, download);
        expect(text).toBe("[nie udało się przepisać]");
        expect(download).not.toHaveBeenCalled();
    });

    it("marks silence and API failures instead of throwing", async () => {
        expect(await transcribeVoiceMessages(msgWith(voice()), async () => "  ", download)).toEqual(["[cisza lub brak mowy]"]);
        jest.spyOn(console, "error").mockImplementation(() => {});
        expect(await transcribeVoiceMessages(msgWith(voice()), async () => { throw new Error("boom"); }, download)).toEqual(["[nie udało się przepisać]"]);
    });

    it("clips very long transcripts", async () => {
        const [text] = await transcribeVoiceMessages(msgWith(voice()), async () => "a".repeat(5000), download);
        expect(text.length).toBe(3001);
        expect(text.endsWith("…")).toBe(true);
    });
});

describe("voice attachments in the archive row", () => {
    const base = (atts: any[]) => ({
        id: "9", channelId: "c", author: { id: "u", username: "u", globalName: "U" }, content: "", embeds: [], createdTimestamp: 1,
        ...msgWith(...atts),
    });

    it("recognises voice messages by audio type plus duration", () => {
        expect(isVoiceAttachment(voice())).toBe(true);
        expect(isVoiceAttachment(voice({ duration: undefined }))).toBe(false);
        expect(isVoiceAttachment({ contentType: "image/png", duration: 3 })).toBe(false);
    });

    it("stores the transcript instead of the generic attachment marker", () => {
        expect(buildArchiveRow(base([voice()]), { voiceTranscripts: ["Cześć"] }).attachmentsText).toBe("[Głosówka: Cześć]");
        expect(describeAttachments(base([voice(), voice()]), undefined, ["a", "b"])).toBe("[Głosówka 1: a] [Głosówka 2: b]");
    });

    it("keeps the plain attachment marker when there is no transcript (backfill, feature off)", () => {
        expect(buildArchiveRow(base([voice()])).attachmentsText).toBe("[Załącznik: voice-message.ogg (audio/ogg)]");
    });
});

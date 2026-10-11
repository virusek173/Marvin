import axios from "axios";

const MAX_CONTENT_PER_URL = 4000;
const MAX_DOWNLOAD_BYTES = 400_000;
const URL_REGEX = /https?:\/\/[^\s<>"]+/g;

function stripHtml(html: string): string {
    const mainStart = html.search(/<(main|article)[\s>]/i);
    return (mainStart > 0 ? html.slice(mainStart) : html)
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, '')
        .replace(/\sdata-[\w-]+=(?:"[^"]*"|'[^']*')/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

const DISCORD_MESSAGE_LINK = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\//i;

export function extractUrls(text: string): string[] {
    return (text.match(URL_REGEX) ?? []).filter(url => !DISCORD_MESSAGE_LINK.test(url));
}

/** Reads at most `maxBytes` of the response body and drops the rest, so a huge page yields its beginning instead of an error. */
async function readHead(stream: NodeJS.ReadableStream & { destroy(): void }, maxBytes: number): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(buf);
        size += buf.length;
        if (size >= maxBytes) {
            stream.destroy();
            break;
        }
    }
    return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

export async function scrapeUrl(url: string): Promise<string | null> {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarvinBot/1.0)' },
            timeout: 8000,
            responseType: 'stream',
        });
        const text = stripHtml(await readHead(response.data, MAX_DOWNLOAD_BYTES));
        return text.substring(0, MAX_CONTENT_PER_URL);
    } catch (error: any) {
        console.error(`Scraper error [${url}]:`, error.message);
        return null;
    }
}

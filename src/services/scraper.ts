import axios from "axios";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

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

/** True for loopback, private, link-local, carrier-grade NAT, multicast and other non-public addresses (IPv4 and IPv6). */
export function isPrivateAddress(address: string): boolean {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (isIP(address) === 4) {
        const [a, b] = address.split(".").map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    if (isIP(address) === 6) {
        const lower = address.toLowerCase();
        return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
    }
    return false;
}

function assertPublicHost(hostname: string): void {
    const host = hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isPrivateAddress(host)) throw new Error("Adres wewnętrzny jest zablokowany");
}

/** DNS lookup that refuses non-public addresses; used by the agents so every redirect hop and DNS answer is checked. */
const safeLookup = ((hostname: string, options: any, callback: any) => {
    dns.lookup(hostname, options, (error: any, address: any, family: any) => {
        if (error) return callback(error, address, family);
        const addresses: string[] = Array.isArray(address) ? address.map((a: any) => a.address) : [address];
        if (addresses.some(isPrivateAddress)) return callback(new Error("Adres wewnętrzny jest zablokowany"), address, family);
        callback(null, address, family);
    });
}) as any;

const httpAgent = new http.Agent({ lookup: safeLookup });
const httpsAgent = new https.Agent({ lookup: safeLookup });

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
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Dozwolone są tylko adresy http(s)");
        assertPublicHost(parsed.hostname);
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarvinBot/1.0)' },
            timeout: 8000,
            responseType: 'stream',
            httpAgent,
            httpsAgent,
            beforeRedirect: (options: any) => assertPublicHost(options.hostname ?? ""),
        });
        const text = stripHtml(await readHead(response.data, MAX_DOWNLOAD_BYTES));
        return text.substring(0, MAX_CONTENT_PER_URL);
    } catch (error: any) {
        console.error(`Scraper error [${url}]:`, error.message);
        return null;
    }
}

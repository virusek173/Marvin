import axios from "axios";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

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

const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) NON_PUBLIC.addSubnet(net, prefix, "ipv6");

/** True for loopback, private, link-local, carrier-grade NAT, multicast and other non-public addresses (IPv4 and IPv6, including IPv4-mapped). */
export function isPrivateAddress(address: string): boolean {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPrivateAddress(mapped[1]);
    const family = isIP(address);
    return family !== 0 && NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
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

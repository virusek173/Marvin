import axios from "axios";

const MAX_CONTENT_PER_URL = 4000;
const URL_REGEX = /https?:\/\/[^\s<>"]+/g;

function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
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

export function extractUrls(text: string): string[] {
    return text.match(URL_REGEX) ?? [];
}

export async function scrapeUrl(url: string): Promise<string | null> {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarvinBot/1.0)' },
            timeout: 8000,
            maxContentLength: 500_000,
        });
        const text = stripHtml(String(response.data));
        return text.substring(0, MAX_CONTENT_PER_URL);
    } catch (error: any) {
        console.error(`Scraper error [${url}]:`, error.message);
        return null;
    }
}

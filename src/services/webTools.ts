import type { ToolSpec } from "./openai.js";
import { extractUrls, scrapeUrl } from "./scraper.js";

const MAX_FETCHES_PER_QUESTION = 3;

/** Tools that reach the open internet. `onFetch` is called after each page that was actually read. */
export const buildWebTools = (onFetch: () => void): ToolSpec[] => {
    let fetches = 0;
    return [
        {
            name: "fetch_url",
            description:
                "Pobiera tekst strony pod podanym adresem (początek, do 4000 znaków). Użyj, gdy ktoś pyta o treść linku (z tej wiadomości albo z wcześniejszych) " +
                "lub gdy bez niej nie odpowiesz. Nie pobieraj linków, o które nikt nie pyta. Nie działa dla linków do wiadomości z Discorda (to archiwum) ani dla adresów wewnętrznych.",
            parameters: {
                type: "object",
                properties: { url: { type: "string", description: "Pełny adres http(s), skopiowany z wiadomości." } },
                required: ["url"],
            },
            run: async raw => {
                const url = typeof raw?.url === "string" ? raw.url.trim() : "";
                if (!/^https?:\/\//i.test(url)) return { error: "Podaj pełny adres zaczynający się od http:// lub https://." };
                if (extractUrls(url).length === 0) return { error: "To link do wiadomości z serwera, użyj narzędzi archiwum." };
                if (fetches >= MAX_FETCHES_PER_QUESTION) return { error: "Limit pobranych stron na to pytanie wyczerpany." };
                fetches++;
                const content = await scrapeUrl(url);
                if (!content) return { error: "Nie udało się pobrać strony." };
                onFetch();
                return { url, content };
            },
        },
    ];
};

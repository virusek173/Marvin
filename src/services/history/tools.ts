import type { ToolSpec } from "../openai.js";
import { HistoryQuery } from "./query.js";

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

const FILTER_PROPS = {
    author: str("Imię autora, np. Jacek, Madzia, Domin (opcjonalnie)."),
    channel: str("Nazwa kanału bez #, np. ogolny (opcjonalnie)."),
    from: str("Początek zakresu, czas warszawski: YYYY-MM-DD albo YYYY-MM-DDTHH:MM (opcjonalnie)."),
    to: str("Koniec zakresu włącznie, czas warszawski: YYYY-MM-DD albo YYYY-MM-DDTHH:MM (opcjonalnie)."),
};

const asArgs = (value: unknown): Record<string, any> => (value && typeof value === "object" ? (value as Record<string, any>) : {});
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asInt = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

/** Read-only tools that expose the message archive to the model. They receive only the query layer, never Discord. */
export const buildHistoryTools = (query: HistoryQuery): ToolSpec[] => [
    {
        name: "search_messages",
        description:
            "Szuka w archiwum wiadomości serwera Discord po słowach (wszystkie podane słowa muszą wystąpić; dopasowanie po początku słowa, " +
            "więc podawaj rdzenie bez końcówek, np. 'kurtk'; gdy żadna wiadomość nie ma wszystkich słów, dostajesz te z którymkolwiek z nich). " +
            "Wiadomości botów (w tym Twoje własne) są pomijane, chyba że podasz autora albo include_bots=true. Wyniki posortowane wg trafności. Zwraca id, kanał, autora, czas i treść.",
        parameters: {
            type: "object",
            properties: {
                query: str("Słowa do wyszukania, np. 'urlop sierpień'."),
                ...FILTER_PROPS,
                limit: int("Maks. liczba wyników (domyślnie 10, maks. 25)."),
                include_bots: { type: "boolean", description: "true = szukaj też w wiadomościach botów, w tym Marvina (domyślnie pomijane)." },
            },
            required: ["query"],
        },
        run: raw => {
            const a = asArgs(raw);
            return query.search({
                query: asString(a.query) ?? "",
                author: asString(a.author),
                channel: asString(a.channel),
                from: asString(a.from),
                to: asString(a.to),
                limit: asInt(a.limit),
                includeBots: a.include_bots === true,
            });
        },
    },
    {
        name: "get_messages",
        description:
            "Zwraca wiadomości z zakresu czasu (zawsze ułożone od najstarszej), np. 'co działo się wczoraj'. Opcjonalnie z jednego kanału lub od jednej osoby. " +
            "Gdy w zakresie jest więcej wiadomości niż limit, dostajesz najwcześniejsze — zawęź zakres, żeby zobaczyć kolejne. " +
            "Do pytań o 'ostatnie N wiadomości' ustaw newest=true i limit=N (wtedy daty są zbędne): dostaniesz dokładnie N najnowszych wiadomości w jednym wywołaniu — nie zgaduj okna dat i nie dociągaj kolejnych porcji, chyba że użytkownik prosi o więcej.",
        parameters: {
            type: "object",
            properties: {
                ...FILTER_PROPS,
                limit: int("Maks. liczba wiadomości (domyślnie 50, maks. 100)."),
                newest: { type: "boolean", description: "true = zwróć NAJNOWSZE wiadomości z zakresu (przy braku dat: z całego archiwum)." },
            },
            required: [],
        },
        run: raw => {
            const a = asArgs(raw);
            return query.range({
                author: asString(a.author),
                channel: asString(a.channel),
                from: asString(a.from),
                to: asString(a.to),
                limit: asInt(a.limit),
                newest: a.newest === true,
            });
        },
    },
    {
        name: "get_message_context",
        description: "Zwraca wiadomości sąsiadujące z wybraną wiadomością (przed i po niej, z tego samego kanału). Użyj po search_messages, żeby zobaczyć kontekst rozmowy.",
        parameters: {
            type: "object",
            properties: { message_id: str("Id wiadomości z wyniku wyszukiwania."), before: int("Ile wiadomości przed (domyślnie 5, maks. 15)."), after: int("Ile po (domyślnie 5, maks. 15).") },
            required: ["message_id"],
        },
        run: raw => {
            const a = asArgs(raw);
            return query.around({ messageId: asString(a.message_id) ?? "", before: asInt(a.before), after: asInt(a.after) });
        },
    },
    {
        name: "list_channels",
        description: "Lista kanałów (i wątków) w archiwum z liczbą zapisanych wiadomości. Użyj, gdy nie jesteś pewien nazwy kanału.",
        parameters: { type: "object", properties: {} },
        run: () => {
            const channels = query.listChannels();
            return { count: channels.length, channels };
        },
    },
];

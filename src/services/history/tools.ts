import type { ToolSpec } from "../openai.js";
import { HistoryQuery, STATS_GROUPS } from "./query.js";

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

const FILTER_PROPS = {
    author: str("Imię autora, np. Jacek, Madzia, Domin (opcjonalnie)."),
    reply_to_author: str("Tylko wiadomości, które są jawną odpowiedzią (funkcja 'odpowiedz') na wiadomość tej osoby, np. 'ile razy Wiktor odpisał Jackowi' = author Wiktor + reply_to_author Jacek (opcjonalnie)."),
    channel: str("Nazwa kanału bez #, np. ogolny (opcjonalnie)."),
    from: str("Początek zakresu, czas warszawski: YYYY-MM-DD albo YYYY-MM-DDTHH:MM (opcjonalnie)."),
    to: str("Koniec zakresu włącznie, czas warszawski: YYYY-MM-DD albo YYYY-MM-DDTHH:MM (opcjonalnie)."),
};

const asArgs = (value: unknown): Record<string, any> => (value && typeof value === "object" ? (value as Record<string, any>) : {});
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asInt = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

const filtersFrom = (a: Record<string, any>) => ({
    author: asString(a.author),
    replyTo: asString(a.reply_to_author),
    channel: asString(a.channel),
    from: asString(a.from),
    to: asString(a.to),
});

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
                ...filtersFrom(a),
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
                ...filtersFrom(a),
                limit: asInt(a.limit),
                newest: a.newest === true,
            });
        },
    },
    {
        name: "get_conversation",
        description:
            "Zwraca całą rozmowę, do której należy wybrana wiadomość: sąsiednie wiadomości z tego samego kanału bez przerwy dłuższej niż gap_minutes (domyślnie 30 min), od najstarszej. " +
            "Użyj po search_messages, gdy trafienie to tylko fragment i trzeba zrozumieć, o co w rozmowie chodziło, kto co ustalił i jak się skończyła. " +
            "Pole 'conversation' mówi, ile wiadomości ma cała rozmowa i kiedy trwała; gdy jest dłuższa niż limit, dostajesz okno wokół wybranej wiadomości.",
        parameters: {
            type: "object",
            properties: {
                message_id: str("Id wiadomości z wyniku wyszukiwania."),
                gap_minutes: int("Największa przerwa między wiadomościami w jednej rozmowie, w minutach (domyślnie 30, maks. 240)."),
                limit: int("Maks. liczba zwracanych wiadomości (domyślnie 40, maks. 100)."),
            },
            required: ["message_id"],
        },
        run: raw => {
            const a = asArgs(raw);
            return query.conversation({ messageId: asString(a.message_id) ?? "", gapMinutes: asInt(a.gap_minutes), limit: asInt(a.limit) });
        },
    },
    {
        name: "get_stats",
        description:
            "Liczy wiadomości w archiwum i grupuje je, np. 'kto ile napisał', 'który dzień był najgłośniejszy', 'ile wiadomości w sierpniu', 'ile razy padło słowo X'. " +
            "Zwraca dokładne liczby z całego archiwum (nie pobieraj wiadomości, żeby je liczyć ręcznie). Liczy tylko wiadomości ludzi, chyba że include_bots=true albo podano autora. " +
            "Bez group_by zwraca tylko łączną liczbę pasujących wiadomości oraz datę pierwszej i ostatniej (bez filtrów dat to właśnie początek i koniec archiwum — użyj tego przy pytaniach o 'pierwszą wiadomość' i 'od początku'). " +
            "Z with_length=true dodaje średnią długość wiadomości (znaki i słowa; tylko wiadomości z tekstem), np. 'średnia długość wiadomości Wiktora i Masona' = group_by author, with_length. " +
            "Z filtrem reply_to_author liczy odpowiedzi jednej osoby na wiadomości drugiej. " +
            "Z filtrem reply_to_author liczy odpowiedzi jednej osoby na wiadomości drugiej.",
        parameters: {
            type: "object",
            properties: {
                group_by: { type: "string", enum: [...STATS_GROUPS], description: "Po czym grupować: author, channel, day, month, weekday (dzień tygodnia), hour (godzina doby). Pominięte = tylko suma." },
                query: str("Policz tylko wiadomości zawierające te słowa (dopasowanie po początku słowa, wszystkie podane słowa), np. 'rower'. Opcjonalnie."),
                ...FILTER_PROPS,
                include_bots: { type: "boolean", description: "true = wliczaj też wiadomości botów, w tym Marvina (domyślnie pomijane)." },
                with_length: { type: "boolean", description: "true = dodaj średnią długość wiadomości (avgChars, avgWords, textMessages) do sumy i każdej grupy." },
                sort: { type: "string", enum: ["count", "key", "length"], description: "count = od największej liczby, key = chronologicznie / alfabetycznie, length = od najdłuższej średniej wiadomości (włącza with_length). Domyślnie: count, a dla month/weekday/hour key." },
                limit: int("Maks. liczba grup (domyślnie 20, maks. 60)."),
            },
            required: [],
        },
        run: raw => {
            const a = asArgs(raw);
            return query.stats({
                groupBy: asString(a.group_by),
                query: asString(a.query),
                ...filtersFrom(a),
                includeBots: a.include_bots === true,
                sort: asString(a.sort),
                limit: asInt(a.limit),
                withLength: a.with_length === true,
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
        name: "get_profile",
        description:
            "Zwraca wygenerowany, nieoficjalny profil osoby z serwera albo innego bota (np. Mugda, Wibot): zainteresowania, ulubione tematy, styl pisania, typowe żarty (powstaje z jej wiadomości i odświeża się raz w tygodniu). " +
            "Użyj do pytań w stylu 'co lubi Madzia', 'jaki jest Wiktor', 'z czego żartuje Mason', 'jaka jest Mugda'. Bez parametru person zwraca wszystkie profile.",
        parameters: {
            type: "object",
            properties: { person: str("Imię osoby, np. Madzia, Jacek (opcjonalnie; bez niego dostaniesz wszystkich).") },
            required: [],
        },
        run: raw => query.profiles(asString(asArgs(raw).person)),
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

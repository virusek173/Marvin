const STOPWORDS = new Set([
    "jest", "jestem", "jesteś", "jesteśmy", "jesteście", "było", "była", "były", "będzie", "będę", "będziesz", "byłem", "byłam", "byli", "mamy", "mają", "masz", "mieć", "miał", "miała",
    "żeby", "żebyś", "który", "która", "które", "której", "którego", "których", "tego", "tamto", "tutaj", "tylko", "bardzo", "jeszcze", "teraz", "wtedy", "przez", "przed", "przy", "pomiędzy",
    "można", "trzeba", "chyba", "może", "możesz", "mogę", "moim", "moje", "moja", "twoje", "twoja", "jakie", "jaki", "jaka", "kiedy", "gdzie", "skąd", "dlaczego", "dlatego", "właśnie",
    "wszystko", "wszyscy", "wszystkie", "dobra", "dobrze", "ktoś", "coś", "nic", "nich", "nimi", "tych", "takie", "taki", "taka", "tak", "jakoś", "jednak", "także", "również", "potem",
    "znowu", "zawsze", "nigdy", "ciągle", "wiem", "wiesz", "myślę", "mówi", "mówię", "robić", "robi", "ktoś", "sobie", "siebie", "swoje", "swój", "dalej", "jakby", "niech", "oraz", "albo",
    "ale", "czyli", "więc", "gdyby", "gdyż", "ponieważ", "czemu", "czasem", "chce", "chcesz", "chcę", "tego", "tamte", "tych", "tym", "temu", "naszego", "nasze", "nasz", "oczywiście",
    "haha", "hahaha", "okej", "okey", "jakiś", "jakaś", "jakieś", "wcale", "prawie", "razem", "bez", "pod", "nad", "dla", "dziś", "dzisiaj", "jutro", "wczoraj",
]);

const MIN_WORD = 4;
const MIN_PAIR_PART = 3;
const MAX_WORD = 25;

/** Lowercase words of a message in order; links, mentions, custom emoji and code are dropped. Each item says whether it can be shown on its own. */
export const tokenize = (text: string): { word: string; useful: boolean }[] =>
    text
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/<[@#:a][^>]*>/g, " ")
        .replace(/```[\s\S]*?```|`[^`]*`/g, " ")
        .split(/[^\p{L}\p{N}]+/u)
        .filter(w => w.length > 0)
        .map(word => ({
            word,
            // "xddd" and "hahaha" are laughter, not topics: two distinct letters at most
            useful: word.length <= MAX_WORD && !/^\d+$/.test(word) && !STOPWORDS.has(word) && new Set(word).size > 2,
        }));

export interface PhraseCount {
    phrase: string;
    count: number;
}

/** Counts words and adjacent word pairs, each at most once per message so that spam of one word does not dominate. */
export class PhraseCounter {
    private words = new Map<string, number>();
    private pairs = new Map<string, number>();

    add(text: string): void {
        const tokens = tokenize(text);
        const seenWords = new Set<string>();
        const seenPairs = new Set<string>();
        tokens.forEach((t, i) => {
            if (t.useful && t.word.length >= MIN_WORD) seenWords.add(t.word);
            const next = tokens[i + 1];
            if (next && t.useful && next.useful && t.word.length >= MIN_PAIR_PART && next.word.length >= MIN_PAIR_PART) {
                seenPairs.add(`${t.word} ${next.word}`);
            }
        });
        for (const w of seenWords) this.words.set(w, (this.words.get(w) ?? 0) + 1);
        for (const p of seenPairs) this.pairs.set(p, (this.pairs.get(p) ?? 0) + 1);
    }

    top(kind: "words" | "pairs", limit: number, minCount: number): PhraseCount[] {
        return [...(kind === "words" ? this.words : this.pairs)]
            .filter(([, count]) => count >= minCount)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, limit)
            .map(([phrase, count]) => ({ phrase, count }));
    }
}

import fs from "node:fs";
import path from "node:path";

export interface TokenUsage {
    input: number;
    cached: number;
    output: number;
    reasoning: number;
}

export interface UsageBucket extends TokenUsage {
    calls: number;
}

/** day (YYYY-MM-DD) → call kind → model → totals */
export type UsageData = Record<string, Record<string, Record<string, UsageBucket>>>;

export const USAGE_FILE = "data/usage.json";

const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });

/** Per-day token totals by call kind and model, kept in memory and flushed to a JSON file (survives container rebuilds via the data volume). */
export class UsageTracker {
    private data: UsageData = {};
    private timer: NodeJS.Timeout | null = null;

    constructor(private file: string = USAGE_FILE, private flushDelayMs = 5000) {
        try {
            this.data = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
            this.data = {};
        }
    }

    record(kind: string, model: string, usage: TokenUsage, day: string = today()) {
        const bucket = ((this.data[day] ??= {})[kind] ??= {})[model] ??= { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
        bucket.calls++;
        bucket.input += usage.input;
        bucket.cached += usage.cached;
        bucket.output += usage.output;
        bucket.reasoning += usage.reasoning;
        this.scheduleFlush();
    }

    snapshot(): UsageData {
        return this.data;
    }

    flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(this.data));
        } catch (error: any) {
            console.error("[usage] nie udało się zapisać statystyk:", error?.message);
        }
    }

    private scheduleFlush() {
        if (this.timer) return;
        this.timer = setTimeout(() => this.flush(), this.flushDelayMs);
        this.timer.unref?.();
    }
}

export const usageTracker = new UsageTracker();

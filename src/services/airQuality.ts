import axios from "axios";
import type { ToolSpec } from "./openai.js";

const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 8000;
const POINTS_API = "https://api-shipx-pl.easypack24.net/v1/points/";
const SHIPX_DATA_PATH = /data-shipx-url="(\/shipx-point-data\/\d+\/([A-Za-z0-9]+)\/air_index_level)"/;

const LEVELS: Record<string, string> = {
    VERY_BAD: "bardzo zła",
    BAD: "zła",
    SATISFACTORY: "dostateczna",
    MODERATE: "umiarkowana",
    GOOD: "dobra",
    VERY_GOOD: "bardzo dobra",
};

const SENSORS: Record<string, { name: string; unit: string }> = {
    PM1: { name: "PM1", unit: "µg/m³" },
    PM25: { name: "PM2,5", unit: "µg/m³" },
    PM10: { name: "PM10", unit: "µg/m³" },
    O3: { name: "ozon (O3)", unit: "µg/m³" },
    NO2: { name: "dwutlenek azotu (NO2)", unit: "µg/m³" },
    SO2: { name: "dwutlenek siarki (SO2)", unit: "µg/m³" },
    CO: { name: "tlenek węgla (CO)", unit: "µg/m³" },
    TEMPERATURE: { name: "temperatura", unit: "°C" },
    PRESSURE: { name: "ciśnienie", unit: "hPa" },
    HUMIDITY: { name: "wilgotność", unit: "%" },
};

export interface Measurement {
    name: string;
    value: number;
    unit?: string;
    percentOfNorm?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Parses the `NAME:value:percentOfNorm` entries of the InPost air_sensors list; entries without a numeric value are skipped. */
export function parseSensors(entries: unknown): Measurement[] {
    if (!Array.isArray(entries)) return [];
    const result: Measurement[] = [];
    for (const entry of entries) {
        if (typeof entry !== "string") continue;
        const [rawName, rawValue, rawPercent] = entry.split(":");
        const value = rawValue === undefined || rawValue === "" ? NaN : Number(rawValue);
        if (!rawName || !Number.isFinite(value)) continue;
        const known = SENSORS[rawName.toUpperCase()];
        const measurement: Measurement = { name: known?.name ?? rawName, value: round2(value) };
        if (known?.unit) measurement.unit = known.unit;
        const percent = rawPercent === undefined || rawPercent === "" ? NaN : Number(rawPercent);
        if (Number.isFinite(percent)) measurement.percentOfNorm = round2(percent);
        result.push(measurement);
    }
    return result;
}

export const translateLevel = (level: unknown): string | null =>
    typeof level === "string" ? LEVELS[level.toUpperCase()] ?? null : null;

export interface Http {
    get: (url: string, config?: any) => Promise<{ data: any; headers: any }>;
    post: (url: string, data?: any, config?: any) => Promise<{ data: any; headers: any }>;
}

const warsawTime = (date: Date): string =>
    date.toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" });

/**
 * Air quality from the sensor of one InPost parcel locker. `pageUrl` is that locker's inpost.pl page (kept in .env, not in the repo):
 * the page names the data endpoint, which answers a POST made with the cookies the page itself set.
 * Returns the tool factory; the 10-minute cache lives in the closure, so create it once.
 */
export function createAirQuality(pageUrl: string, http: Http = axios as unknown as Http, now: () => Date = () => new Date()) {
    let cached: { at: number; value: Record<string, unknown> } | null = null;

    const fetchReading = async (): Promise<Record<string, unknown>> => {
        const page = new URL(pageUrl);
        if (page.protocol !== "https:" || !/(^|\.)inpost\.pl$/.test(page.hostname)) throw new Error("Nieprawidłowy adres strony czujnika");
        const config = { timeout: TIMEOUT_MS, maxRedirects: 0, headers: { "User-Agent": "Mozilla/5.0 (compatible; MarvinBot/1.0)" } };

        const pageResponse = await http.get(pageUrl, { ...config, responseType: "text" });
        const found = SHIPX_DATA_PATH.exec(String(pageResponse.data));
        if (!found) throw new Error("Strona paczkomatu nie wskazuje źródła danych");
        const [, dataPath, lockerName] = found;
        const cookies = ([] as string[]).concat(pageResponse.headers?.["set-cookie"] ?? []).map(c => c.split(";")[0]).join("; ");

        const [dataResult, pointResult] = await Promise.allSettled([
            http.post(page.origin + dataPath, undefined, {
                ...config,
                headers: { ...config.headers, Cookie: cookies, Referer: pageUrl, Origin: page.origin, "X-Requested-With": "XMLHttpRequest" },
            }),
            http.get(POINTS_API + lockerName, config),
        ]);

        const point = pointResult.status === "fulfilled" ? pointResult.value.data : null;
        const data = dataResult.status === "fulfilled" ? dataResult.value.data : null;
        const level = translateLevel(data?.air_index_level ?? point?.air_index_level);
        const measurements = parseSensors(data?.air_sensors);
        if (!level && measurements.length === 0) throw new Error("Czujnik nie zwrócił danych");

        const address = [point?.address?.line1, point?.address?.line2].filter(Boolean).join(", ");
        const reading: Record<string, unknown> = {
            source: `czujnik w paczkomacie InPost ${lockerName}${address ? `, ${address}` : ""}`,
            fetchedAt: `${warsawTime(now())} (czas warszawski)`,
            airQualityLevel: level,
            measurements,
        };
        if (measurements.length === 0) reading.note = "Szczegółowe pomiary chwilowo niedostępne, jest tylko ogólny poziom jakości powietrza.";
        return reading;
    };

    return (onData: () => void): ToolSpec[] => [
        {
            name: "get_air_quality",
            description:
                "Aktualna jakość powietrza w Poznaniu z czujnika w pobliskim paczkomacie InPost: ogólny poziom, pyły PM1/PM2,5/PM10 (z procentem normy), temperatura, ciśnienie, wilgotność. " +
                "Użyj, gdy ktoś pyta o jakość powietrza, smog, pyły albo aktualne warunki przy tym czujniku. Zawsze powiedz, że dane pochodzą z tego paczkomatu (pole source).",
            parameters: { type: "object", properties: {} },
            run: async () => {
                try {
                    if (!cached || now().getTime() - cached.at > CACHE_MS) cached = { at: now().getTime(), value: await fetchReading() };
                    onData();
                    return cached.value;
                } catch (error: any) {
                    console.error("Air quality error:", error.message);
                    return { error: "Nie udało się pobrać danych z czujnika w paczkomacie." };
                }
            },
        },
    ];
}

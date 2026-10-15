import * as fs from "fs";
import type { AirReading } from "./airQuality.js";

export const AIR_ALERT_STATE_FILE = "data/air_alert.json";
export const AIR_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const AIR_ALERT_CONFIRMATIONS = 2;
const DAY_START_HOUR = 7;
const DAY_END_HOUR = 22;

/** 0 = fine, 1 = BAD, 2 = VERY_BAD. */
export const airSeverity = (levelCode: string | null): number => (levelCode === "VERY_BAD" ? 2 : levelCode === "BAD" ? 1 : 0);

export interface AirAlertState {
    /** Worst level already announced in the current episode; 0 = no open episode. */
    alertedSeverity: number;
    lastAlertAt: string | null;
    /** Consecutive readings worse than `alertedSeverity`. */
    streak: number;
    /** Consecutive fine readings while an episode is open. */
    goodStreak: number;
}

export const initialAirAlertState = (): AirAlertState => ({ alertedSeverity: 0, lastAlertAt: null, streak: 0, goodStreak: 0 });

export type AirAlertAction = "alert" | "recovery" | null;

export const isAirAlertDaytime = (date: Date): boolean => {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", hour: "2-digit", hourCycle: "h23" }).format(date));
    return hour >= DAY_START_HOUR && hour < DAY_END_HOUR;
};

/**
 * One reading in, next state and what to post out. An alert needs two bad readings in a row, a new episode also the cooldown
 * since the last alert (a worse level inside an episode does not), and nothing is posted outside daytime: the state stays
 * pending, so a bad (or recovered) situation that lasts is announced on the first daytime reading.
 */
export function evaluateAirAlert(state: AirAlertState, levelCode: string | null, now: Date): { state: AirAlertState; action: AirAlertAction } {
    const severity = airSeverity(levelCode);
    const next = { ...state };
    const daytime = isAirAlertDaytime(now);

    next.streak = severity > state.alertedSeverity ? state.streak + 1 : 0;
    next.goodStreak = state.alertedSeverity > 0 && severity === 0 ? state.goodStreak + 1 : 0;

    if (next.streak >= AIR_ALERT_CONFIRMATIONS && daytime) {
        const cooledDown = !state.lastAlertAt || now.getTime() - new Date(state.lastAlertAt).getTime() >= AIR_ALERT_COOLDOWN_MS;
        if (state.alertedSeverity > 0 || cooledDown) {
            return { state: { alertedSeverity: severity, lastAlertAt: now.toISOString(), streak: 0, goodStreak: 0 }, action: "alert" };
        }
    }
    if (next.goodStreak >= AIR_ALERT_CONFIRMATIONS && daytime) {
        return { state: { ...next, alertedSeverity: 0, streak: 0, goodStreak: 0 }, action: "recovery" };
    }
    return { state: next, action: null };
}

export function readAirAlertState(file: string = AIR_ALERT_STATE_FILE): AirAlertState {
    try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        return {
            alertedSeverity: [0, 1, 2].includes(raw.alertedSeverity) ? raw.alertedSeverity : 0,
            lastAlertAt: typeof raw.lastAlertAt === "string" ? raw.lastAlertAt : null,
            streak: Number.isInteger(raw.streak) ? raw.streak : 0,
            goodStreak: Number.isInteger(raw.goodStreak) ? raw.goodStreak : 0,
        };
    } catch {
        return initialAirAlertState();
    }
}

export function writeAirAlertState(state: AirAlertState, file: string = AIR_ALERT_STATE_FILE): void {
    try {
        fs.writeFileSync(file, JSON.stringify(state, null, 2));
    } catch (error: any) {
        console.error("Error writing air alert state:", error?.message);
    }
}

const num = (n: number): string => String(n).replace(".", ",");

/** The fixed part of the alert: level, the dust readings with % of norm, temperature, source and hour. No model involved. */
export function formatAirAlert(kind: "alert" | "recovery", { reading }: AirReading): string {
    const level = String(reading.airQualityLevel ?? "brak danych").toLocaleUpperCase("pl-PL");
    const measurements = Array.isArray(reading.measurements) ? (reading.measurements as any[]) : [];
    const bullets = ["PM1", "PM2,5", "PM10", "temperatura"].flatMap(name => {
        const m = measurements.find(x => x.name === name);
        if (!m) return [];
        const percent = m.percentOfNorm !== undefined ? ` (${num(m.percentOfNorm)}% normy)` : "";
        return [`• **${name}:** ${num(m.value)}${m.unit ? ` ${m.unit}` : ""}${percent}`];
    });
    const title = kind === "alert" ? `**ALERT JAKOŚCI POWIETRZA: ${level}**` : `**JAKOŚĆ POWIETRZA WRÓCIŁA DO NORMY: ${level}**`;
    const lines = [`📦 ${title}`];
    if (bullets.length > 0) lines.push("", ...bullets);
    lines.push("", `-# Źródło: ${reading.source ?? "czujnik w paczkomacie InPost"}, godz. ${String(reading.fetchedAt ?? "").replace(" (czas warszawski)", "")}`);
    return lines.join("\n");
}

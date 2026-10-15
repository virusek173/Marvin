import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    AIR_ALERT_COOLDOWN_MS,
    airSeverity,
    evaluateAirAlert,
    formatAirAlert,
    initialAirAlertState,
    isAirAlertDaytime,
    readAirAlertState,
    writeAirAlertState,
    type AirAlertState,
} from "../airAlert";

// Warsaw is UTC+2 in summer: 10:00Z = 12:00, 21:00Z = 23:00.
const noon = (minutes = 0) => new Date(Date.UTC(2026, 6, 1, 10, minutes));
const night = new Date(Date.UTC(2026, 6, 1, 21, 0));
const earlyMorning = new Date(Date.UTC(2026, 6, 2, 5, 30)); // 07:30

function run(readings: Array<[string | null, Date]>, state: AirAlertState = initialAirAlertState()) {
    const actions: Array<string | null> = [];
    for (const [level, at] of readings) {
        const result = evaluateAirAlert(state, level, at);
        state = result.state;
        actions.push(result.action);
    }
    return { state, actions };
}

describe("airSeverity / daytime", () => {
    it("treats only BAD and VERY_BAD as bad", () => {
        expect(["VERY_GOOD", "GOOD", "MODERATE", "SATISFACTORY", null].map(airSeverity)).toEqual([0, 0, 0, 0, 0]);
        expect([airSeverity("BAD"), airSeverity("VERY_BAD")]).toEqual([1, 2]);
    });

    it("is daytime 07:00-22:00 Warsaw time", () => {
        expect(isAirAlertDaytime(noon())).toBe(true);
        expect(isAirAlertDaytime(earlyMorning)).toBe(true);
        expect(isAirAlertDaytime(night)).toBe(false);
        expect(isAirAlertDaytime(new Date(Date.UTC(2026, 6, 1, 4, 59)))).toBe(false); // 06:59
    });
});

describe("evaluateAirAlert", () => {
    it("alerts only after two bad readings in a row", () => {
        expect(run([["BAD", noon(0)], ["BAD", noon(30)]]).actions).toEqual([null, "alert"]);
        expect(run([["BAD", noon(0)], ["GOOD", noon(30)], ["BAD", noon(60)]]).actions).toEqual([null, null, null]);
    });

    it("does not repeat while the episode lasts", () => {
        expect(run([["BAD", noon(0)], ["BAD", noon(30)], ["BAD", noon(60)], ["BAD", noon(90)]]).actions).toEqual([null, "alert", null, null]);
    });

    it("alerts again when it gets worse, once per level", () => {
        const { actions } = run([
            ["BAD", noon(0)], ["BAD", noon(30)],
            ["VERY_BAD", noon(60)], ["VERY_BAD", noon(90)],
            ["BAD", noon(120)], ["VERY_BAD", noon(150)], ["VERY_BAD", noon(180)],
        ]);
        expect(actions).toEqual([null, "alert", null, "alert", null, null, null]);
    });

    it("sends a recovery message after two fine readings and then closes the episode", () => {
        const { actions, state } = run([["BAD", noon(0)], ["BAD", noon(30)], ["MODERATE", noon(60)], ["GOOD", noon(90)], ["GOOD", noon(120)]]);
        expect(actions).toEqual([null, "alert", null, "recovery", null]);
        expect(state.alertedSeverity).toBe(0);
    });

    it("does not announce recovery when the level only improved from very bad to bad", () => {
        const { actions } = run([["VERY_BAD", noon(0)], ["VERY_BAD", noon(30)], ["BAD", noon(60)], ["BAD", noon(90)]]);
        expect(actions).toEqual([null, "alert", null, null]);
    });

    it("applies a cooldown to a new episode but not inside one", () => {
        const first = run([["BAD", noon(0)], ["BAD", noon(30)], ["GOOD", noon(60)], ["GOOD", noon(90)]]);
        expect(first.actions).toEqual([null, "alert", null, "recovery"]);
        const soon = run([["BAD", noon(120)], ["BAD", noon(150)]], first.state);
        expect(soon.actions).toEqual([null, null]);
        const later = new Date(noon(30).getTime() + AIR_ALERT_COOLDOWN_MS);
        const after = run([["BAD", later]], soon.state);
        expect(after.actions).toEqual(["alert"]);
    });

    it("holds an alert over the night and sends it at the first daytime reading", () => {
        const { actions } = run([["BAD", night], ["BAD", new Date(night.getTime() + 30 * 60000)], ["BAD", earlyMorning]]);
        expect(actions).toEqual([null, null, "alert"]);
    });

    it("holds the recovery message over the night too", () => {
        const opened = run([["BAD", noon(0)], ["BAD", noon(30)]]).state;
        const { actions } = run([["GOOD", night], ["GOOD", new Date(night.getTime() + 30 * 60000)], ["GOOD", earlyMorning]], opened);
        expect(actions).toEqual([null, null, "recovery"]);
    });

    it("does not alert for a problem that already went away overnight", () => {
        const { actions } = run([["BAD", night], ["BAD", new Date(night.getTime() + 30 * 60000)], ["GOOD", earlyMorning]]);
        expect(actions).toEqual([null, null, null]);
    });
});

describe("state file", () => {
    it("round-trips and falls back to a clean state for a missing or broken file", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "air-alert-"));
        const file = path.join(dir, "air_alert.json");
        expect(readAirAlertState(file)).toEqual(initialAirAlertState());
        const state = { alertedSeverity: 2, lastAlertAt: "2026-07-01T10:00:00.000Z", streak: 0, goodStreak: 1 };
        writeAirAlertState(state, file);
        expect(readAirAlertState(file)).toEqual(state);
        fs.writeFileSync(file, "{not json");
        expect(readAirAlertState(file)).toEqual(initialAirAlertState());
    });
});

describe("formatAirAlert", () => {
    const current = {
        levelCode: "BAD",
        reading: {
            source: "czujnik w paczkomacie InPost TEST01M, Przykładowa 1, 00-001 Poznań",
            fetchedAt: "12:30 (czas warszawski)",
            airQualityLevel: "zła",
            measurements: [
                { name: "PM1", value: 20.5, unit: "µg/m³" },
                { name: "PM2,5", value: 45.2, unit: "µg/m³", percentOfNorm: 180.8 },
                { name: "PM10", value: 70, unit: "µg/m³", percentOfNorm: 140 },
                { name: "ciśnienie", value: 1006.8, unit: "hPa" },
                { name: "temperatura", value: 3.2, unit: "°C" },
            ],
        },
    };

    it("lists level, dust, temperature, source and hour", () => {
        expect(formatAirAlert("alert", current)).toBe(
            [
                "📦 **ALERT JAKOŚCI POWIETRZA: ZŁA**",
                "",
                "• **PM1:** 20,5 µg/m³",
                "• **PM2,5:** 45,2 µg/m³ (180,8% normy)",
                "• **PM10:** 70 µg/m³ (140% normy)",
                "• **temperatura:** 3,2 °C",
                "",
                "-# Źródło: czujnik w paczkomacie InPost TEST01M, Przykładowa 1, 00-001 Poznań, godz. 12:30",
            ].join("\n"),
        );
    });

    it("words the recovery message differently and copes with level-only readings", () => {
        const text = formatAirAlert("recovery", { levelCode: "GOOD", reading: { source: "s", fetchedAt: "08:00 (czas warszawski)", airQualityLevel: "dobra", measurements: [] } });
        expect(text).toBe("📦 **JAKOŚĆ POWIETRZA WRÓCIŁA DO NORMY: DOBRA**\n\n-# Źródło: s, godz. 08:00");
    });
});

import { createAirQuality, parseSensors, translateLevel, type Http } from "../airQuality";

const PAGE = "https://inpost.pl/paczkomat-test-test01m-przykladowa";
const PAGE_HTML = '<div class="shipx-data" data-shipx-url="/shipx-point-data/123/TEST01M/air_index_level"></div>';
const DATA = {
    air_index_level: "VERY_GOOD",
    air_sensors: ["PM1:0.28:", "PM25:0.49:3.26", "PM10:0.61:1.36", "PRESSURE:1006.83:", "HUMIDITY:74.5:", "TEMPERATURE:13.83:"],
};
const POINT = { name: "TEST01M", address: { line1: "Przykładowa 1", line2: "00-001 Poznań" }, air_index_level: "VERY_GOOD" };

function fakeHttp(overrides: { post?: () => Promise<any>; point?: () => Promise<any>; page?: string } = {}) {
    const http = {
        get: jest.fn(async (url: string) => {
            if (url.startsWith("https://api-shipx-pl.easypack24.net/")) return overrides.point ? overrides.point() : { data: POINT, headers: {} };
            return { data: overrides.page ?? PAGE_HTML, headers: { "set-cookie": ["__cf_bm=abc; Path=/; HttpOnly", "sess=xyz; Path=/"] } };
        }),
        post: jest.fn(async () => (overrides.post ? overrides.post() : { data: DATA, headers: {} })),
    };
    return http;
}

describe("parseSensors", () => {
    it("maps known sensors to Polish names, units and percent of norm", () => {
        expect(parseSensors(DATA.air_sensors)).toEqual([
            { name: "PM1", value: 0.28, unit: "µg/m³" },
            { name: "PM2,5", value: 0.49, unit: "µg/m³", percentOfNorm: 3.26 },
            { name: "PM10", value: 0.61, unit: "µg/m³", percentOfNorm: 1.36 },
            { name: "ciśnienie", value: 1006.83, unit: "hPa" },
            { name: "wilgotność", value: 74.5, unit: "%" },
            { name: "temperatura", value: 13.83, unit: "°C" },
        ]);
    });

    it("keeps unknown sensors by raw name and skips entries without a numeric value", () => {
        expect(parseSensors(["XYZ:1.5:", "PM25::", "PM10:abc:", "garbage", 7, ""])).toEqual([{ name: "XYZ", value: 1.5 }]);
        expect(parseSensors(undefined)).toEqual([]);
    });
});

describe("translateLevel", () => {
    it("translates InPost levels and ignores unknown ones", () => {
        expect(translateLevel("VERY_GOOD")).toBe("bardzo dobra");
        expect(translateLevel("BAD")).toBe("zła");
        expect(translateLevel("WHATEVER")).toBeNull();
        expect(translateLevel(null)).toBeNull();
    });
});

describe("get_air_quality tool", () => {
    const run = async (http: Http, now = () => new Date("2026-10-11T12:30:00Z")) => {
        const onData = jest.fn();
        const [tool] = createAirQuality(PAGE, http, now)(onData);
        return { tool, onData };
    };

    it("posts to the endpoint named by the page with the page's cookies and returns all readings with the source", async () => {
        const http = fakeHttp();
        const { tool, onData } = await run(http as unknown as Http);
        const result: any = await tool.run({});
        expect(http.post).toHaveBeenCalledWith(
            "https://inpost.pl/shipx-point-data/123/TEST01M/air_index_level",
            undefined,
            expect.objectContaining({ headers: expect.objectContaining({ Cookie: "__cf_bm=abc; sess=xyz", Referer: PAGE, Origin: "https://inpost.pl" }) })
        );
        expect(result.source).toBe("czujnik w paczkomacie InPost TEST01M, Przykładowa 1, 00-001 Poznań");
        expect(result.airQualityLevel).toBe("bardzo dobra");
        expect(result.measurements).toHaveLength(6);
        expect(result.fetchedAt).toBe("14:30 (czas warszawski)");
        expect(onData).toHaveBeenCalledTimes(1);
    });

    it("caches the reading for 10 minutes", async () => {
        const http = fakeHttp();
        let time = new Date("2026-10-11T12:00:00Z").getTime();
        const { tool } = await run(http as unknown as Http, () => new Date(time));
        await tool.run({});
        time += 9 * 60 * 1000;
        await tool.run({});
        expect(http.post).toHaveBeenCalledTimes(1);
        time += 2 * 60 * 1000;
        await tool.run({});
        expect(http.post).toHaveBeenCalledTimes(2);
    });

    it("falls back to the level from the public API when the sensor endpoint fails", async () => {
        const http = fakeHttp({ post: () => Promise.reject(new Error("403")) });
        const { tool, onData } = await run(http as unknown as Http);
        const result: any = await tool.run({});
        expect(result.airQualityLevel).toBe("bardzo dobra");
        expect(result.measurements).toEqual([]);
        expect(result.note).toMatch(/niedostępne/);
        expect(onData).toHaveBeenCalledTimes(1);
    });

    it("returns an error and does not report data when nothing is available", async () => {
        const http = fakeHttp({ post: () => Promise.reject(new Error("403")), point: () => Promise.resolve({ data: { ...POINT, air_index_level: null }, headers: {} }) });
        const { tool, onData } = await run(http as unknown as Http);
        expect(await tool.run({})).toEqual({ error: "Nie udało się pobrać danych z czujnika w paczkomacie." });
        expect(onData).not.toHaveBeenCalled();
    });

    it("errors when the page does not name a data endpoint, without posting", async () => {
        const http = fakeHttp({ page: "<html>nic</html>" });
        const { tool } = await run(http as unknown as Http);
        expect(await tool.run({})).toHaveProperty("error");
        expect(http.post).not.toHaveBeenCalled();
    });

    it("refuses a configured page outside inpost.pl", async () => {
        const http = fakeHttp();
        const [tool] = createAirQuality("https://evil.example.com/x", http as unknown as Http)(jest.fn());
        expect(await tool.run({})).toHaveProperty("error");
        expect(http.get).not.toHaveBeenCalled();
    });
});

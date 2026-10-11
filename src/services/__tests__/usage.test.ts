import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageTracker } from "../usage";

describe("UsageTracker", () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-")); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const u = (input: number, cached = 0, output = 0, reasoning = 0) => ({ input, cached, output, reasoning });

    it("sums calls per day, kind and model", () => {
        const t = new UsageTracker(path.join(dir, "usage.json"));
        t.record("question", "m1", u(100, 40, 10, 5), "2026-10-10");
        t.record("question", "m1", u(50, 10, 5, 0), "2026-10-10");
        t.record("image", "m2", u(30), "2026-10-10");
        t.record("question", "m1", u(1), "2026-10-11");
        expect(t.snapshot()["2026-10-10"].question.m1).toEqual({ calls: 2, input: 150, cached: 50, output: 15, reasoning: 5 });
        expect(t.snapshot()["2026-10-10"].image.m2.calls).toBe(1);
        expect(Object.keys(t.snapshot())).toEqual(["2026-10-10", "2026-10-11"]);
        t.flush();
    });

    it("persists to the file and continues from it after a restart", () => {
        const file = path.join(dir, "nested", "usage.json");
        const first = new UsageTracker(file);
        first.record("summary", "m1", u(10), "2026-10-10");
        first.flush();

        const second = new UsageTracker(file);
        second.record("summary", "m1", u(5), "2026-10-10");
        expect(second.snapshot()["2026-10-10"].summary.m1).toMatchObject({ calls: 2, input: 15 });
        second.flush();
    });

    it("starts empty when the file is missing or corrupt", () => {
        const file = path.join(dir, "usage.json");
        fs.writeFileSync(file, "{not json");
        expect(new UsageTracker(file).snapshot()).toEqual({});
        expect(new UsageTracker(path.join(dir, "none.json")).snapshot()).toEqual({});
    });
});

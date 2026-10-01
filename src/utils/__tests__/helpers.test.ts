import { pushWithLimit, parseContextTimestamp, splitForDiscord } from '../helpers';

describe('splitForDiscord', () => {
    it('leaves a short reply untouched', () => {
        expect(splitForDiscord('krótko')).toEqual(['krótko']);
    });

    it('splits at line boundaries instead of mid-word, keeping every part within the limit', () => {
        const lines = Array.from({ length: 40 }, (_, i) => `- punkt ${i} ${'x'.repeat(40)}`);
        const parts = splitForDiscord(lines.join('\n'), 500, 10);
        expect(parts.length).toBeGreaterThan(1);
        expect(parts.every(p => p.length <= 500)).toBe(true);
        expect(parts.join('\n')).toBe(lines.join('\n'));
    });

    it('cuts a text without any boundary and caps the number of parts', () => {
        const parts = splitForDiscord('a'.repeat(5000), 1000, 3);
        expect(parts).toHaveLength(3);
        expect(parts.every(p => p.length <= 1000)).toBe(true);
    });
});

describe('parseContextTimestamp', () => {
    it('parses the leading timestamp prefix', () => {
        expect(parseContextTimestamp('[2026.09.29 18:53] Domin: hej')).toEqual(new Date(2026, 8, 29, 18, 53));
    });

    it('returns null when there is no prefix', () => {
        expect(parseContextTimestamp('bez daty')).toBeNull();
        expect(parseContextTimestamp(undefined)).toBeNull();
    });
});

describe('pushWithLimit', () => {
    it('should add items to array up to the limit', () => {
        const array: number[] = [];

        pushWithLimit(array, 1);
        expect(array).toEqual([1]);

        pushWithLimit(array, 2);
        expect(array).toEqual([1, 2]);
    });

    it('should remove oldest item when limit is reached', () => {
        const array: number[] = [];
        const limit = 3;

        pushWithLimit(array, 1, limit);
        pushWithLimit(array, 2, limit);
        pushWithLimit(array, 3, limit);
        pushWithLimit(array, 4, limit);

        expect(array).toEqual([2, 3, 4]);
    });

    it('should handle undefined/null items', () => {
        const array: any[] = [];

        pushWithLimit(array, undefined);
        expect(array).toEqual([]);

        pushWithLimit(array, null);
        expect(array).toEqual([]);
    });

    it('should use default limit of 10', () => {
        const array: number[] = [];

        for (let i = 1; i <= 11; i++) {
            pushWithLimit(array, i);
        }

        expect(array).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });
});

import { pushWithLimit, parseContextTimestamp } from '../helpers';

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

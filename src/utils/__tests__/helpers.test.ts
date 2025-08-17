import { pushWithLimit } from '../helpers';

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

    it('should use default limit of 5', () => {
        const array: number[] = [];

        pushWithLimit(array, 1);
        pushWithLimit(array, 2);
        pushWithLimit(array, 3);
        pushWithLimit(array, 4);
        pushWithLimit(array, 5);
        pushWithLimit(array, 6);

        expect(array).toEqual([2, 3, 4, 5, 6]);
    });
});

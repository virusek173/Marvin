declare global {
  interface Array<T> {
    pushWithLimit(elem: T, limit?: number): Array<T>;
  }
}

export type HolidayObject = Record<string, string>;

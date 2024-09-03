import { getFormattedDate, getFormattedDateForPrompt } from "../helpers.js";

describe("getFormattedDate", () => {
  test("Testing function with date format 1", () => {
    const date1 = new Date("December 15, 1995 03:24:00");
    const date2 = new Date("January 05, 1995 03:24:00");
    const date3 = new Date("February 28, 1995 03:24:00");

    expect(getFormattedDate(date1)).toBe("1215");
    expect(getFormattedDate(date2)).toBe("0105");
    expect(getFormattedDate(date3)).toBe("0228");
  });

  test("Testing function with date format 2", () => {
    // November 25, 1989 6:30:00 PM
    const date1 = new Date(628021800000);
    // February 25, 2024 8:13:29 PM
    const date2 = new Date(1708892009000);
    // July 14, 2024 8:13:29 PM
    const date3 = new Date(1720988009000);

    expect(getFormattedDate(date1)).toBe("1125");
    expect(getFormattedDate(date2)).toBe("0225");
    expect(getFormattedDate(date3)).toBe("0714");
  });

  test("Testing function with date format 3", () => {
    const date1 = new Date("1995-05-19T03:24:00");
    const date2 = new Date("1995-07-16T03:24:00");
    const date3 = new Date("1995-11-11T03:24:00");

    expect(getFormattedDate(date1)).toBe("0519");
    expect(getFormattedDate(date2)).toBe("0716");
    expect(getFormattedDate(date3)).toBe("1111");
  });

  test("Testing function with date format 4", () => {
    const date1 = new Date(2020, 0, 1);
    const date2 = new Date(2020, 2, 21);
    const date3 = new Date(2020, 6, 3);

    expect(getFormattedDate(date1)).toBe("0101");
    expect(getFormattedDate(date2)).toBe("0321");
    expect(getFormattedDate(date3)).toBe("0703");
  });

  test("Testing function with date format 5", () => {
    const date1 = new Date(2023, 8, 10, 23, 15, 34, 0);
    const date2 = new Date(2023, 2, 12, 23, 15, 34, 0);
    const date3 = new Date(2023, 8, 11, 23, 15, 34, 0);

    expect(getFormattedDate(date1)).toBe("0910");
    expect(getFormattedDate(date2)).toBe("0312");
    expect(getFormattedDate(date3)).toBe("0911");
  });
});

describe("getFormattedDateForPrompt", () => {
  test("Testing function with date format 1", () => {
    const date1 = new Date("December 15, 1995 03:24:00");
    const date2 = new Date("January 05, 2001 03:24:00");
    const date3 = new Date("February 28, 2023 03:24:00");

    expect(getFormattedDateForPrompt(date1)).toBe("1995.12.15");
    expect(getFormattedDateForPrompt(date2)).toBe("2001.01.05");
    expect(getFormattedDateForPrompt(date3)).toBe("2023.02.28");
  });

  test("Testing function with date format 2", () => {
    // November 25, 1989 6:30:00 PM
    const date1 = new Date(628021800000);
    // February 25, 2024 8:13:29 PM
    const date2 = new Date(1708892009000);
    // July 14, 2024 8:13:29 PM
    const date3 = new Date(1720988009000);

    expect(getFormattedDateForPrompt(date1)).toBe("1989.11.25");
    expect(getFormattedDateForPrompt(date2)).toBe("2024.02.25");
    expect(getFormattedDateForPrompt(date3)).toBe("2024.07.14");
  });

  test("Testing function with date format 3", () => {
    const date1 = new Date("1995-05-19T03:24:00");
    const date2 = new Date("2003-07-16T03:24:00");
    const date3 = new Date("2011-11-11T03:24:00");

    expect(getFormattedDateForPrompt(date1)).toBe("1995.05.19");
    expect(getFormattedDateForPrompt(date2)).toBe("2003.07.16");
    expect(getFormattedDateForPrompt(date3)).toBe("2011.11.11");
  });

  test("Testing function with date format 4", () => {
    const date1 = new Date(2001, 0, 1);
    const date2 = new Date(2021, 2, 21);
    const date3 = new Date(2027, 6, 3);

    expect(getFormattedDateForPrompt(date1)).toBe("2001.01.01");
    expect(getFormattedDateForPrompt(date2)).toBe("2021.03.21");
    expect(getFormattedDateForPrompt(date3)).toBe("2027.07.03");
  });

  test("Testing function with date format 5", () => {
    const date1 = new Date(2020, 8, 10, 23, 15, 34, 0);
    const date2 = new Date(2013, 2, 12, 23, 15, 34, 0);
    const date3 = new Date(2007, 8, 11, 23, 15, 34, 0);

    expect(getFormattedDateForPrompt(date1)).toBe("2020.09.10");
    expect(getFormattedDateForPrompt(date2)).toBe("2013.03.12");
    expect(getFormattedDateForPrompt(date3)).toBe("2007.09.11");
  });
});

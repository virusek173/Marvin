import { DateService } from "../date.js";

describe("getFormattedDate", () => {
  test("Testing function with date format 1", () => {
    const date1 = new DateService("December 15, 1995 03:24:00");
    const date2 = new DateService("January 05, 2001 03:24:00");
    const date3 = new DateService("February 28, 2023 03:24:00");

    expect(date1.getFormattedDate()).toBe("1995.12.15");
    expect(date2.getFormattedDate()).toBe("2001.01.05");
    expect(date3.getFormattedDate()).toBe("2023.02.28");
  });

  test("Testing function with date format 2", () => {
    // November 25, 1989 6:30:00 PM
    const date1 = new DateService(628021800000);
    // February 25, 2024 8:13:29 PM
    const date2 = new DateService(1708892009000);
    // July 14, 2024 8:13:29 PM
    const date3 = new DateService(1720988009000);

    expect(date1.getFormattedDate()).toBe("1989.11.25");
    expect(date2.getFormattedDate()).toBe("2024.02.25");
    expect(date3.getFormattedDate()).toBe("2024.07.14");
  });

  test("Testing function with date format 3", () => {
    const date1 = new DateService("1995-05-19T03:24:00");
    const date2 = new DateService("2003-07-16T03:24:00");
    const date3 = new DateService("2011-11-11T03:24:00");

    expect(date1.getFormattedDate()).toBe("1995.05.19");
    expect(date2.getFormattedDate()).toBe("2003.07.16");
    expect(date3.getFormattedDate()).toBe("2011.11.11");
  });
});

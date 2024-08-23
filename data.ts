import { HolidayObject } from "./model.js";

export const holidayList: Array<string> = [
  "Światowy dzień depresji",
  "Światowy Dzień Kaca",
  "Dzień Ciasta Lodowego",
  "Dzień Filatelisty",
  "Dzień Dziwaka",
  "Ogólnopolski Dzień Walki z Depresją",
  "Święto Bułki, Dzień bez Alkoholu, Światowy Dzień Mleka",
  "Międzynarodowy Dzień Przytulania, Święto Niepodległości (Nauru)",
  "Światowy Dzień Środków Masowego Przekazu, Dzień Gospodarczego Wyzwolenia (Togo), Dzień Prawienia Komplementów",
];

export const holidayData: Array<HolidayObject> = holidayList.map(
  (holiday: string, index: number) => ({
    date: `08${20 + index}`,
    holiday,
  })
);

import OpenAI from "openai";
import { getFormattedDateForPrompt } from "./helpers.js";

const openai = new OpenAI();

const DEFAULT_TEMPERATURE = 1;

export const getMotivationSystemContext = (
  date: string,
  marvinId: string | undefined
) => {
  return [
    {
      role: "system",
      content: `
        Nazywasz się Marvin.
        Dzisiejsza data to ${date}.
        Jesteś botem discordowym, który jest turbo motywatorem. Mocno chwalisz się ile już dzisiaj osiągnąłeś i motywujesz innych do pracy.
        Twoje motto to napie\*dalać jak najwięcej akcji w ciągu dnia. Zachęcasz do tego innych, bo trzeba napie\*dalać.
        Odpowiadaj krótko, zwięźle i na temat.
        Osoby z ekipy/drużyny/rodziny/połączenia/diskordziaki które znasz:
        Jacek - Jest Mega Kotem, jak tylko masz jakiś problem to możesz go przywołać. Na pewno pomoże.
        Domin - Biega maratony, ma owłosioną klatę oraz super rodzinę. Możesz go przywołać. Utożsami się z Tobą.
        Mariusz - Nic Sobą nie reprezentuje.
        Mason - Jest ekspertem w robieniu muzyki i ćwiczeniach fizycznych.
        Wiktor - Zawsze mówi wierszem i improwizuje. Możesz go przywołać, żeby pocieszył swoim stylem.
        Madzia - Jest super i ma tyłek. Możesz ją przywołać, żeby pocieszyła tym co ma.
        Podsumowuś - Podsumowywuje wszystko. Możesz go wywołać, żeby coś podsumował.
        ${marvinId
          ? `<@${marvinId}> to wywołanie Ciebie, ale nie wspominaj o tym.`
          : ""
        },
        Jak wspomnisz jedną z osób to zrób to w ten sposób:
        Jacek(<@577167877107351789>)
        Domin(<@297092766981423105>)
        Mariusz(<@640536326164185121>)
        Wiktor(<@219778599106904075>)
        Basia(<brak zgody na przywołanie>)
        Madzia(<@692087500465766442>)
        Podsumowuś(<@1256922551284797506>)
  `,
    },
  ];
};

export const getFirstMotivionUserMessage = (quote: string) => [
  {
    role: "user",
    content: `
      Zacznij od ogólnego przywitania wszystkich.
      Przywitaj się z przywołaniem @here.
      Motywujący cytat na dziś to: ${quote}.
      Wpleć go w Twoją powitalną wiadomość. Nie pisz, że to cytat, ale załącz go w oryginalnej formie z autorem.
      Napisz coś żeby zmotywować ludzi na cały dzień.
    `,
  },
];

export const getTodayQuoteContextPrompt = () => [
  {
    role: "user",
    content: `Podaj mi istniejący motywujący i inspirujący cytat. 
    Odpowiedz tylko nim i autorem. Niczym więcej.`,
  },
];

export const getQuote = async (): Promise<string> => {
  const quoteContextPrompt = getTodayQuoteContextPrompt();
  const quoteResponse = await openAiInteraction(
    quoteContextPrompt,
    "gpt-4o",
    DEFAULT_TEMPERATURE
  );
  return quoteResponse?.content;
};

export const openAiInteraction = async (
  context: Array<any>,
  model: string = "gpt-4o-mini",
  temperature: number = DEFAULT_TEMPERATURE
): Promise<any> => {
  console.log(">>>>>>>> context <<<<<<<<", model, context, context.length);

  const completion = await openai.chat.completions.create({
    model,
    messages: context,
    temperature,
  });

  return completion.choices[0].message;
};

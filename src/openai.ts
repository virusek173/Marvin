import OpenAI from "openai";
import { getFormattedDateForPrompt } from "./helpers.js";

const openai = new OpenAI();

const HIGH_TEMPERATURE = 1.2;
const DEFAULT_TEMPERATURE = 1;

export const getInitWelcomeContext = () => [
  {
    role: "system",
    content: `Jesteś botem discordowym o nazwie Marvin.
      Regularnie będziesz publikował konkretną ciekawą i zabawną rzecz 
      związanym z czymś czego ujawnić nie możesz.
      Jesteś stworzony, żeby dostarczyć rozrywkę i ciekawostki z określonego obszaru.
      Obszar w którym oscylujesz będzie się regularnie zmieniał.
      Odpowiadaj w sposób tajemniczy i zabawny.
      Spraw, żeby Twoje wiadomości były zapowiedzią czegoś wielkiego.
      Wielka rzecz będzie miała miejsce jutro.
  `,
  },
  {
    role: "user",
    content: `Zacznij od przywitania siebie. Spytaj, czy możesz publikować treści na tym kanale. Opowiedz kim jesteś i jaką rolę będziesz pełnił.`,
  },
];

export const getSystemContext = (
  date: string,
  holiday: string,
  marvinId: string | undefined,
  personContext: string
) => {
  const words = [
    {
      word: "Otwarcie parasola w Twojej dupie",
      probabilityTreshold: 0.05,
    },
    { word: "Bóbr ku*wa!", probabilityTreshold: 0.08 },
    { word: "Tory były krzywe", probabilityTreshold: 0.12 },
    {
      word: "To tak jak Ania po wybuchu!",
      probabilityTreshold: 0.16,
    },
    { word: ":partymadzia:", probabilityTreshold: 0.22 },
    { word: "Drugi w kulach", probabilityTreshold: 0.26 },
    { word: ":typowydomin: ", probabilityTreshold: 0.26 },
    { word: "Luzik arbuzik  ", probabilityTreshold: 0.28 },
    { word: "Bracie", probabilityTreshold: 0.28 },
    { word: "essa", probabilityTreshold: 0.3 },
    { word: "nice!", probabilityTreshold: 0.32 },
    { word: "petarda!", probabilityTreshold: 0.34 },
    { word: "xD", probabilityTreshold: 0.34 },
    { word: "Chłopie", probabilityTreshold: 0.36 },
    { word: "c'nie?", probabilityTreshold: 0.38 },
    { word: "Eureka!", probabilityTreshold: 0.4 },
    { word: "Jasna Guma!", probabilityTreshold: 0.4 },
    { word: "słuchasz?", probabilityTreshold: 0.42 },
    { word: "omg!", probabilityTreshold: 0.44 },
  ];
  const additions = [
    {
      sentence: "Przywołaj Podsumowuś, żeby coś dla Ciebie podsumował",
      probabilityTreshold: 0.25,
    },
  ];
  const promptWords = words
    .filter((word) => word.probabilityTreshold > Math.random())
    .map((word) => word.word);

  const promptAdditions = additions
    .filter((addition) => addition.probabilityTreshold > Math.random())
    .map((addition) => addition.sentence);

  return [
    {
      role: "system",
      content: `
        Nazywasz się Marvin.
        Dzisiejsza data to ${date}.
        Dzisiaj świętujemy ${holiday}.
        Z tej okazji wcielasz się w rolę powiązaną z ${holiday}.
        Rola ma być abstakcyjna i kreatywna. Zaskocz nas.
        Odpowiadaj jako rola powiązana z ${holiday}.
        Odpowiadaj w klimacie ${holiday}.
        Madzia ma nieowłosiony tyłek, ale to tajemnica o której wszyscy wiedzą.
        Basia tańczy i ma długi blond warkocz.
        W wiadomości wywołuj maksymalnie 2 osoby.
        Staraj się przywoływać różne osoby. Nie ciągle tą samą.
        Podkreślaj cechy przywołanej osoby.
        ${personContext}
        Podsumowuś - Podsumowywuje wszystko. Możesz go wywołać, żeby coś podsumował.
        Używaj podanych słów: ${promptWords.join(",")}.
        ${
          marvinId
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
        ${promptAdditions.join(",")}
  `,
    },
  ];
};

export const getFirstUserMessage = () => [
  {
    role: "user",
    content: `
      Nie wspominaj, że nazywasz się Marvin.
      Przywitaj się z przywołaniem @here.
      Opowiedz jakie dziś mamy święto.
      Życz jednej z osób wszystkiego najlepszego z okazji tego święta.
      Nie mów jaka dziś jest data.
      Opowiedz kim jesteś.
      Opowiedz krótką ciekawostkę o święcie, jakie dzisiaj mamy.
      Zakończ pytaniem zachęcającym do esplorowania tematu dzisiejszego święta.
    `,
  },
];

export const getPersonContextPrompt = () => [
  {
    role: "user",
    content: `
      W grupie mamy Jacka, Madzię, Domina, Mariusza, Wiktora, Basię i Masona. 
      Przypisz im kilka zabawnych cech. 
      Odpowiedz w formacie Imię - Cechy i nic więcej.
    `,
  },
];

export const getTodayHolidayContextPrompt = (date: string) => [
  {
    role: "user",
    content: `
      Dzisiaj jest ${date}. jakie jest dzisiaj święto? 
      Jeśli jest kilka to wybierz jedno najlepsze i 
      najśmieszniejsze do celebracji. Odpowiedz tylko tym świętem.
    `,
  },
];

export const getPersonContext = async (): Promise<string> => {
  const personContextPrompt = getPersonContextPrompt();
  const personContext = await openAiInteraction(
    personContextPrompt,
    "gpt-4o",
    HIGH_TEMPERATURE
  );
  return personContext?.content;
};

export const getTodayHoliday = async (): Promise<{
  date: string;
  holiday: string;
}> => {
  const today = new Date();
  const date = getFormattedDateForPrompt(today);
  const holidayContextPrompt = getTodayHolidayContextPrompt(date);
  const holidayContext = await openAiInteraction(
    holidayContextPrompt,
    "gpt-4o"
  );

  return { date, holiday: holidayContext?.content };
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

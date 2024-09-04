import OpenAI from "openai";
import { ChatCompletionMessage } from "openai/resources";

const openai = new OpenAI();

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
  marvinId: string | undefined
) => {
  const words = [
    { word: "c'nie?", probabilityTreshold: 0.5 },
    { word: "Chłopie", probabilityTreshold: 0.5 },
    { word: "nice!", probabilityTreshold: 0.5 },
    { word: "essa", probabilityTreshold: 0.3 },
    { word: "petarda!", probabilityTreshold: 0.3 },
    { word: "Bracie", probabilityTreshold: 0.3 },
    { word: "Drugi w kulach", probabilityTreshold: 0.2 },
    { word: "Tory były krzywe", probabilityTreshold: 0.1 },
    { word: "Bóbr ku*wa!", probabilityTreshold: 0.05 },
    {
      word: "Otwarcie parasola w Twojej dupie",
      probabilityTreshold: 0.05,
    },
  ];
  const promptWords = words
    .filter((word) => word.probabilityTreshold > Math.random())
    .map((word) => word.word);

  return [
    {
      role: "system",
      content: `
        Dzisiejsza data to ${date}.
        Dzisiaj świętujemy ${holiday}.
        Poszczególne święta mogą być oddzielone przecinkami.
        Odwołaj się do każdego ze świąt.
        Z tej okazji wcielam się w rolę powiązaną z ${holiday}.
        Rola ma być maksymalnie abstakcyjna i zabawna.
        Odpowiadaj jako rola powiązana z ${holiday}.
        Odpowiadaj w klimacie ${holiday}.
        Madzia ma nieowłosiony tyłek, to tajemnica, ale wszyscy o tym wiedzą.
        Używaj słów takich jak: ${promptWords.join(",")}
        ${
          marvinId
            ? `${marvinId} to wywołanie Ciebie, ale nie wspominaj o tym.`
            : ""
        },
  `,
    },
  ];
};

export const getFirstUserMessage = () => [
  {
    role: "user",
    content: `
      Przywitaj się z przywołaniem @here.
      Opowiedz jakie dziś mamy święto.
      Nie mów jaka dziś jest data.
      Opowiedz kim jesteś.
      Opowiedz krótką ciekawostkę o święcie, jakie dzisiaj mamy.
      Zakończ pytaniem zachęcającym do esplorowania tematu dzisiejszego święta.
    `,
  },
];

export const openAiInteraction = async (context: Array<any>): Promise<any> => {
  console.log(">>>>>>>> context <<<<<<<<", context, context.length);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: context,
  });

  return completion.choices[0].message;
};

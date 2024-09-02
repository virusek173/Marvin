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

export const getInitContext = (
  holiday: string,
  marvinId: string | undefined
) => {
  return [
    {
      role: "system",
      content: `
      Dzisiaj jest ${holiday}.
  Poszczególne święta mogą być oddzielone przecinkami.
  Odwołaj się do każdego ze świąt.
  Z tej okazji wcielasz się w rolę powiązaną z ${holiday}.
  Rola ma być maksymalnie abstakcyjna i zabawna.
  Odpowiadaj jako rola powiązana z ${holiday}.
  Odpowiadaj w klimacie ${holiday}.
  Madzia ma nieowłosiony tyłek, nikomu nie możesz o tym powiedzieć.
  ${
    marvinId ? `${marvinId} to wywołanie Ciebie, ale nie wspominaj o tym.` : ""
  },
  `,
    },
    {
      role: "user",
      content: `
    Przywitaj się z przywołaniem @here.
    Opowiedz jakie dziś mamy święto.
    Opowiedz kim jesteś.
    Opowiedz krótką ciekawostkę o święcie, jakie dzisiaj mamy.
    Zakończ pytaniem zachęcającym do esplorowania tematu dzisiejszego święta.`,
    },
  ];
};

export const openAiInteraction = async (context: Array<any>): Promise<any> => {
  console.log(">>>>>>>> context <<<<<<<<", context, context.length);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: context,
  });

  return completion.choices[0].message;
};

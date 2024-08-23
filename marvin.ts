import OpenAI from "openai";

const openai = new OpenAI();

export const initMarvin = async (holiday: string | undefined) => {
  if (!holiday) {
    console.log("Holiday undefined Error.");
    return;
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Dzisiaj jest ${holiday}.
        Z tej okazji wcielasz się w rolę powiązaną z ${holiday}.
        Rola ma być maksymalnie abstakcyjna i zabawna.
        Odpowiadaj jako rola powiązana z ${holiday}.
        Odpowiadaj w klimacie ${holiday}.`,
      },
      {
        role: "user",
        content: `Opowiedz jakie dziś mamy święto.
          Opowiedz kim jesteś.
          Opowiedz krótką ciekawostkę o święcie, jakie dzisiaj mamy.
          Zakończ pytaniem zachęcającym do esplorowania tematu dzisiejszego święta.`,
      },
    ],
  });

  console.log(completion.choices[0].message);
};

import { ProviderSession } from "ai-auth-login";

const session = new ProviderSession({ state: process.env.PROVIDER_STATE });
const client = await session.createSDK();

if (client.ok) {
  const answer = await client.value.responses.create({
    model: process.env.MODEL ?? "your-model",
    input: "Hello!",
  });

  console.log(answer.output_text);
}

await session.close();

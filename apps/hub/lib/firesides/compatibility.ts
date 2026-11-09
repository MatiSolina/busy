import { botCall } from "../chat/store";
import { FiresideConflict } from "./state";

/** Old deployments must never run a guest with their saved model/billing by mistake. */
export async function requireFiresideRuntime(slug: string) {
  const call = botCall(slug);
  const response = await fetch(`${call.url}/eve/v1/info`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${await call.token()}`, ...call.headers },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new FiresideConflict(
      "Couldn't verify this bot's runtime. Please try again."
    );
  }
  const info = (await response.json()) as {
    version?: number;
    tools?: { static?: { name: string }[] };
  };
  if (
    info.version !== 5 ||
    !info.tools?.static?.some((tool) => tool.name === "read_fireside")
  ) {
    throw new FiresideConflict(
      "This bot needs a runtime update before it can join a fireside."
    );
  }
}

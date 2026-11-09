import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ChatApp } from "@/components/chat-app";
import { initialData } from "@/lib/chat/initial";
import { listSections } from "@/lib/sections/store";
import { span } from "@/lib/trace";

interface Props {
  params?: Promise<{ slug: string }>;
}

// Send the selected chat with the page; other histories load on intent.
export function ChatPage({ params }: Props) {
  return <Bots params={params} />;
}

// Resolve the selected conversation before revealing this private page. An empty
// streamed shell adds React's reveal throttle before the usable chat can hydrate.
async function Bots({ params }: Props) {
  await connection();
  const route = await params;
  const [bots, sections] = await Promise.all([
    span("page.initialData", () => initialData(route?.slug)),
    span("page.sections", () => listSections()),
  ]);
  if (route && !bots.some((bot) => bot.slug === route.slug)) {
    notFound();
  }
  return (
    <ChatApp
      initial={bots.map((bot) => {
        // createdAt is server metadata; instructions load when the edit form opens.
        /* eslint-disable @typescript-eslint/no-unused-vars */
        const {
          createdAt: _createdAt,
          instructions: _instructions,
          ...initialBot
        } = bot;
        /* eslint-enable @typescript-eslint/no-unused-vars */
        return initialBot;
      })}
      initialSections={sections}
      selected={route?.slug}
    />
  );
}

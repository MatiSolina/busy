import { ChatPage } from "@/components/chat-page";

export const instant = false;

export default function Page({ params }: PageProps<"/b/[slug]">) {
  return <ChatPage params={params} />;
}

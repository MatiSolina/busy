import { CodeTaskPageClient } from "@/components/code-task-page-client";

export default async function CodeTaskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="bg-background min-h-dvh">
      <CodeTaskPageClient taskId={id} />
    </main>
  );
}

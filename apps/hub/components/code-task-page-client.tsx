"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { CodeTaskDetail } from "@/components/code-task-panel";

export function CodeTaskPageClient({ taskId }: { taskId: string }) {
  const router = useRouter();
  const close = useCallback(
    (open: boolean) => {
      if (!open) {
        router.push("/");
      }
    },
    [router]
  );
  return <CodeTaskDetail onOpenChange={close} open taskId={taskId} />;
}

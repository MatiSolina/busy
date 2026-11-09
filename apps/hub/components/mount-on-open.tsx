"use client";

import { type ReactNode, useState } from "react";

/** Defer panel code and effects until intent, then retain drafts and exit motion. */
export function MountOnOpen({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  if (open && !mounted) {
    setMounted(true);
  }
  return open || mounted ? children : null;
}

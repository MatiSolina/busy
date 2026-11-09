"use client";

import type { ReactNode } from "react";
import styles from "./bot-pane-transition.module.css";

/** Display:none cancels the hidden Activity's animation; CSS restarts it on reveal. */
export function BotPaneTransition({ children }: { children: ReactNode }) {
  return (
    <div className={styles.pane} style={{ opacity: 1, transform: "none" }}>
      {children}
    </div>
  );
}

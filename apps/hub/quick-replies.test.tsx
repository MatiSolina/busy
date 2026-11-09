// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickReplies } from "@/components/quick-replies";

describe("QuickReplies", () => {
  it("sends the tapped reply", () => {
    const onPick = vi.fn();
    render(
      <QuickReplies onPick={onPick} replies={["Send it", "Make it shorter"]} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Make it shorter" }));
    expect(onPick).toHaveBeenCalledWith("Make it shorter");
  });
});

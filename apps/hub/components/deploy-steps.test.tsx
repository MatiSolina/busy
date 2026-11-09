// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploySteps, formatElapsed } from "@/components/deploy-steps";
import type { DeployStep } from "@/lib/bots/progress";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const steps: DeployStep[] = [
  {
    detail: null,
    endedAt: "2026-11-05T12:00:20Z",
    id: "prepare",
    label: "Preparing project and files",
    startedAt: "2026-11-05T12:00:00Z",
    state: "done",
  },
  {
    detail: "Building · Compiling agent…",
    endedAt: null,
    id: "build",
    label: "Building on Vercel",
    startedAt: "2026-11-05T12:00:20Z",
    state: "active",
  },
  {
    detail: null,
    endedAt: null,
    id: "live",
    label: "Going live",
    startedAt: null,
    state: "pending",
  },
];

describe("DeploySteps", () => {
  it("formats elapsed time", () => {
    expect(formatElapsed(7000)).toBe("7s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(-5)).toBe("0s");
  });

  it("lists each step with its state, time and build detail", () => {
    vi.useFakeTimers({ now: new Date("2026-11-05T12:01:25Z") });
    render(<DeploySteps steps={steps} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.dataset.state)).toEqual([
      "done",
      "active",
      "pending",
    ]);
    expect(items[0]?.textContent).toContain("20s");
    expect(items[1]?.textContent).toContain("1m 05s");
    expect(screen.getByText("Building · Compiling agent…")).toBeTruthy();
  });

  it("announces only the current step, politely", () => {
    const { container } = render(<DeploySteps steps={steps} />);
    const live = container.querySelector("[aria-live='polite']");
    expect(live?.textContent).toBe("Building on Vercel: in progress");
  });

  it("does not spin when the user prefers reduced motion", () => {
    const { container } = render(<DeploySteps steps={steps} />);
    expect(container.querySelector(".animate-spin")?.classList).toContain(
      "motion-reduce:animate-none"
    );
  });
});

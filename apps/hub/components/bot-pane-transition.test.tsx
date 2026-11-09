// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react";
import { Activity } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotPaneTransition } from "./bot-pane-transition";
import { disableHappyDomWebAnimations } from "./motion-test-helpers";

const reducedMatchMedia = (query: string): MediaQueryList => ({
  addEventListener: () => undefined,
  addListener: () => undefined,
  dispatchEvent: () => false,
  matches: true,
  media: query,
  onchange: null,
  removeEventListener: () => undefined,
  removeListener: () => undefined,
});

const originalMatchMedia = Object.getOwnPropertyDescriptor(
  window,
  "matchMedia"
);

function Harness({ active }: { active: boolean }) {
  return (
    <Activity mode={active ? "visible" : "hidden"}>
      <BotPaneTransition>
        <input aria-label="Draft" defaultValue="keep this draft" />
      </BotPaneTransition>
    </Activity>
  );
}

beforeEach(() => {
  disableHappyDomWebAnimations();
  vi.stubGlobal("matchMedia", reducedMatchMedia);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: reducedMatchMedia,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalMatchMedia) {
    Object.defineProperty(window, "matchMedia", originalMatchMedia);
  } else {
    Reflect.deleteProperty(window, "matchMedia");
  }
});

describe("BotPaneTransition reduced motion", () => {
  it("keeps the pane at rest and preserves content across Activity reveal", async () => {
    const view = render(<Harness active />);
    await act(async () => {
      await Promise.resolve();
    });

    const input = screen.getByRole("textbox", { name: "Draft" });
    const wrapper = input.parentElement as HTMLDivElement;
    expect(wrapper.style.opacity).toBe("1");
    expect(wrapper.style.transform).toBe("none");

    await act(async () => {
      view.rerender(<Harness active={false} />);
      await Promise.resolve();
    });
    expect(screen.queryByRole("textbox", { name: "Draft" })).toBeNull();

    await act(async () => {
      view.rerender(<Harness active />);
      await Promise.resolve();
    });

    const restored = screen.getByRole("textbox", { name: "Draft" });
    expect(restored).toBe(input);
    expect((restored as HTMLInputElement).value).toBe("keep this draft");
    expect(wrapper.style.opacity).toBe("1");
    expect(wrapper.style.transform).toBe("none");
  });
});

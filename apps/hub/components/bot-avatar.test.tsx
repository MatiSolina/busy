// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { BotAvatar, PixHead } from "@/components/bot-avatar";

afterEach(() => {
  cleanup();
});

const themedAvatars = [
  ["disco", "orange"],
  ["pop", "lavender"],
  ["punk", "night"],
  ["nerd", "lime"],
  ["gamer", "violet"],
  ["chef", "red"],
] as const;

function eyeGeometry(container: HTMLElement) {
  const group = container.querySelector(".pix-avatar-gaze > g");
  if (!group) {
    throw new Error("avatar eyes group was not rendered");
  }
  return [...group.querySelectorAll("rect")].map((eye) => [
    eye.getAttribute("height"),
    eye.getAttribute("y"),
  ]);
}

describe("Pix avatar motion invariants", () => {
  it("keeps the classic eye geometry distinct between idle and working", () => {
    const view = render(<PixHead pix="lime" />);
    expect(eyeGeometry(view.container)).toEqual([
      ["24", "-8"],
      ["24", "-8"],
    ]);

    view.rerender(<PixHead pix="lime" working />);
    expect(eyeGeometry(view.container)).toEqual([
      ["18", "-12"],
      ["18", "-12"],
    ]);
    expect(
      view.container
        .querySelector(".pix-avatar-body")
        ?.classList.contains("pix-avatar-working")
    ).toBe(true);
  });

  it("keeps an external eyes ref attached to the animated SVG group", () => {
    const eyesRef = createRef<SVGGElement>();
    const view = render(<PixHead eyesRef={eyesRef} pix="orange" working />);
    const group = view.container.querySelector(".pix-avatar-gaze > g");

    expect(eyesRef.current).toBe(group);
    expect(eyesRef.current?.classList.contains("pix-avatar-glance")).toBe(true);
  });

  it("renders every saved themed avatar with its working and gaze wrappers", () => {
    for (const [variant, color] of themedAvatars) {
      const view = render(
        <BotAvatar
          avatar={`pix:${variant}:${color}`}
          slug={`theme-${variant}`}
          working
        />
      );
      const root = view.container.querySelector(".pix-avatar");

      expect(root?.getAttribute("data-pix-variant")).toBe(variant);
      expect(
        root
          ?.querySelector(".pix-avatar-body")
          ?.classList.contains("pix-avatar-working")
      ).toBe(true);
      expect(root?.querySelector(".pix-avatar-gaze")).toBeTruthy();
      expect(root?.querySelector(".pix-avatar-glance")).toBeTruthy();
      expect(root?.querySelector("svg")?.getAttribute("viewBox")).toBe(
        "-48 -48 96 96"
      );
      view.unmount();
    }
  });
});

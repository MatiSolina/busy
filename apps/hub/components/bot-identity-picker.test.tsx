// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotIdentityPicker } from "@/components/bot-identity-picker";

const STYLE_BUTTON_NAME = / style$/u;

afterEach(() => {
  cleanup();
});

function ControlledPicker({ initial }: { initial: string }) {
  const [avatar, setAvatar] = useState(initial);
  return <BotIdentityPicker avatar={avatar} onChange={setAvatar} />;
}

describe("themed bot identity picker", () => {
  it("uses the current avatar as the edit trigger until expanded", () => {
    const onChange = vi.fn();
    const { container } = render(
      <BotIdentityPicker avatar="pix:pop:lavender" onChange={onChange} />
    );

    const edit = screen.getByRole("button", { name: "Edit bot identity" });
    expect(edit.textContent?.trim()).toBe("");
    expect(edit.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(edit.querySelector(".pix-avatar")).not.toBeNull();
    expect(container.querySelectorAll(".pix-avatar")).toHaveLength(1);

    fireEvent.click(edit);

    expect(edit.getAttribute("aria-expanded")).toBe("true");
    const optionsId = edit.getAttribute("aria-controls") ?? "";
    expect(screen.getByRole("group", { name: "Style" }).parentElement?.id).toBe(
      optionsId
    );
    expect(screen.getByRole("group", { name: "Color" })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("collapses with Done and keeps the chosen identity when reopened", () => {
    render(<ControlledPicker initial="pix:pop:lavender" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));
    fireEvent.click(screen.getByRole("button", { name: "Orange" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Done editing bot identity" })
    );

    expect(screen.queryByRole("group", { name: "Style" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Color" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));
    expect(
      screen
        .getByRole("button", { name: "Pop style" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Orange" })
        .getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("offers six styles in one group with Classic first", () => {
    render(<ControlledPicker initial="lime" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));

    const styles = screen.getAllByRole("button", { name: STYLE_BUTTON_NAME });
    expect(styles.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Classic style",
      "Disco style",
      "Pop style",
      "Punk style",
      "Nerd style",
      "Gamer style",
    ]);
    expect(new Set(styles.map((button) => button.parentElement)).size).toBe(1);
  });

  it("preserves a saved Chef costume when changing its color", () => {
    const onChange = vi.fn();
    render(<BotIdentityPicker avatar="pix:chef:red" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));

    fireEvent.click(screen.getByRole("button", { name: "Orange" }));

    expect(onChange).toHaveBeenCalledWith("pix:chef:orange");
  });

  it("marks an existing themed identity in both controls", () => {
    render(<ControlledPicker initial="pix:pop:lavender" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));

    expect(
      screen
        .getByRole("button", { name: "Pop style" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Lavender" })
        .getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("keeps the selected costume when changing its color", () => {
    render(<ControlledPicker initial="pix:pop:lavender" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));

    fireEvent.click(screen.getByRole("button", { name: "Orange" }));

    expect(
      screen
        .getByRole("button", { name: "Pop style" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Orange" })
        .getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("emits the canonical themed avatar value for a color change", () => {
    const onChange = vi.fn();
    render(<BotIdentityPicker avatar="pix:pop:lavender" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));

    fireEvent.click(screen.getByRole("button", { name: "Orange" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("pix:pop:orange");
  });

  it("uses the preset color when switching to a different costume", () => {
    render(<ControlledPicker initial="pix:pop:lavender" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));

    fireEvent.click(screen.getByRole("button", { name: "Gamer style" }));

    expect(
      screen
        .getByRole("button", { name: "Gamer style" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Violet" })
        .getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("returns to classic while preserving the current color", () => {
    render(<ControlledPicker initial="pix:pop:orange" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));

    fireEvent.click(screen.getByRole("button", { name: "Classic style" }));

    expect(
      screen
        .getByRole("button", { name: "Classic style" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Orange" })
        .getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("disables both style and color controls while saving", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <BotIdentityPicker avatar="pix:disco:orange" onChange={onChange} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit bot identity" }));
    rerender(
      <BotIdentityPicker
        avatar="pix:disco:orange"
        disabled
        onChange={onChange}
      />
    );

    expect(
      screen.getByRole("button", { name: "Done editing bot identity" })
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "Disco style" }).closest("fieldset")
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "Orange" }).closest("fieldset")
    ).toHaveProperty("disabled", true);

    expect(onChange).not.toHaveBeenCalled();
  });
});

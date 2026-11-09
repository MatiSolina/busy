// @vitest-environment happy-dom
import assert from "node:assert/strict";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InteractionCard,
  type InteractionCardItem,
} from "@/components/interaction-card";

const answer =
  vi.fn<
    (
      slug: string,
      interactionId: string,
      value: { optionId?: string; text?: string }
    ) => Promise<boolean>
  >();

vi.mock("@/components/chat-app", () => ({
  useStore: () => ({ answer }),
}));

const question = (
  over: Partial<InteractionCardItem> = {}
): InteractionCardItem => ({
  allowFreeform: false,
  id: "interaction-1",
  interactionId: "interaction-1",
  kind: "interaction",
  options: [
    { id: "xlsx", label: "Excel" },
    { id: "csv", label: "CSV", style: "secondary" },
  ],
  prompt: "Which export should I use?",
  state: "open",
  type: "question",
  ...over,
});

beforeEach(() => {
  answer.mockReset();
  answer.mockResolvedValue(true);
});
afterEach(cleanup);

describe("InteractionCard", () => {
  it("sends a choice and disables controls until eve settles it", () => {
    render(<InteractionCard item={question()} slug="sales" />);

    fireEvent.click(screen.getByRole("button", { name: "Excel" }));
    expect(answer).toHaveBeenCalledWith("sales", "interaction-1", {
      optionId: "xlsx",
    });
    expect(screen.getByRole("status").textContent).toBe("Sending…");
    expect(
      (screen.getByRole("button", { name: "Excel" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("renders a free-text question and submits its answer", async () => {
    render(
      <InteractionCard
        item={question({
          allowFreeform: true,
          options: [],
          prompt: "What should I call this file?",
        })}
        slug="lawyer"
      />
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), {
      target: { value: "final-report.docx" },
    });
    const form = screen
      .getByRole("textbox", { name: "Your answer" })
      .closest("form");
    assert(form);
    fireEvent.submit(form);
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith("lawyer", "interaction-1", {
        text: "final-report.docx",
      })
    );
  });

  it("keeps the card actionable after a transport failure", async () => {
    answer.mockResolvedValueOnce(false);
    render(<InteractionCard item={question()} slug="sales" />);

    fireEvent.click(screen.getByRole("button", { name: "Excel" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Couldn't send")
    );
    expect(
      (screen.getByRole("button", { name: "Excel" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });

  it("keeps native submitted responses disabled until the stream settles", () => {
    render(<InteractionCard item={question({ pending: true })} slug="sales" />);

    const button = screen.getByRole("button", {
      name: "Excel",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(answer).not.toHaveBeenCalled();
  });

  it("releases a locally locked answer after eve refuses the response", async () => {
    const { rerender } = render(
      <InteractionCard item={question()} slug="sales" />
    );
    fireEvent.click(screen.getByRole("button", { name: "Excel" }));
    await waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
    rerender(
      <InteractionCard item={question({ pending: true })} slug="sales" />
    );
    expect(
      (screen.getByRole("button", { name: "Excel" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    rerender(
      <InteractionCard
        item={question({ error: "Response refused" })}
        slug="sales"
      />
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Excel" }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    );
    expect(screen.getByRole("alert").textContent).toContain("Response refused");
    fireEvent.click(screen.getByRole("button", { name: "Excel" }));
    await waitFor(() => expect(answer).toHaveBeenCalledTimes(2));
  });

  it("does not offer controls after a settled approval", () => {
    render(
      <InteractionCard
        item={question({
          outcome: "Approval declined.",
          state: "rejected",
          type: "approval",
        })}
        slug="sales"
      />
    );

    expect(screen.queryByRole("button", { name: "Excel" })).toBeNull();
    expect(screen.getByText("Approval declined.")).toBeTruthy();
  });

  it("does not expose the repository id after setup is accepted", () => {
    render(
      <InteractionCard
        item={question({
          outcome: "repo-1",
          setup: "code-repository",
          state: "accepted",
        })}
        slug="sales"
      />
    );

    expect(screen.getByText("Answer sent.")).toBeTruthy();
    expect(screen.queryByText("repo-1")).toBeNull();
  });

  it("does not expose the cancel outcome after setup closes", () => {
    render(
      <InteractionCard
        item={question({
          outcome: "cancel",
          setup: "code-repository",
          state: "closed",
        })}
        slug="sales"
      />
    );

    expect(screen.getByText("Repository setup cancelled.")).toBeTruthy();
    expect(screen.queryByText("cancel")).toBeNull();
  });
});

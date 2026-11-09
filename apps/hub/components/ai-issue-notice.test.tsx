// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiIssue } from "@/lib/ai/errors";
import { AiIssueNotice } from "./ai-issue-notice";

vi.mock("@/components/ai-connection-provider", () => ({
  useAiConnectionOptional: () => null,
}));

afterEach(cleanup);

describe("AI failure recovery", () => {
  it("links a ChatGPT allowance failure to ChatGPT usage", () => {
    render(
      <AiIssueNotice issue={aiIssue("provider_quota_exceeded", "chatgpt")} />
    );
    expect(screen.getByRole("alert").textContent).toContain("ChatGPT");
    expect(
      screen.getByRole("link", { name: "Check usage" }).getAttribute("href")
    ).toBe("https://chatgpt.com/settings/usage");
    expect(screen.queryByRole("button", { name: "Retry message" })).toBeNull();
  });

  it("opens the affected bot's settings for an unavailable model", () => {
    const configure = vi.fn();
    render(
      <AiIssueNotice
        issue={aiIssue("model_unavailable", "grok")}
        onConfigureBot={configure}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open bot settings" }));
    expect(configure).toHaveBeenCalledOnce();
  });

  it("uses the Busy login for an expired Busy session", () => {
    render(<AiIssueNotice issue={aiIssue("unauthorized")} />);
    expect(
      screen.getByRole("link", { name: "Sign in to Busy" }).getAttribute("href")
    ).toBe("/login");
    expect(screen.queryByRole("link", { name: "Check usage" })).toBeNull();
  });

  it("directs Token Pass allowance recovery to the account owner", () => {
    render(
      <AiIssueNotice issue={aiIssue("provider_quota_exceeded", "token-pass")} />
    );
    expect(
      screen.getByText(
        "Ask the Busy account owner to check the Vercel allowance and spending limits."
      )
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Check usage" })).toBeNull();
  });
});

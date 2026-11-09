// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it as test } from "vitest";
import type { TaskPlan } from "../../../templates/bot/agent/lib/task-plan";
import { PlanCard } from "./plan-card";

afterEach(cleanup);

const plan: TaskPlan = {
  id: "plan-proposal",
  revision: 1,
  steps: [
    {
      assignee: "Researcher",
      dependsOn: [],
      expectedResult: "Dated sources",
      id: "research",
      note: "Sources checked",
      status: "completed",
      title: "Research Acme",
    },
    {
      assignee: "self",
      dependsOn: ["research"],
      expectedResult: "Proposal document",
      id: "write",
      status: "in_progress",
      title: "Prepare proposal",
    },
    {
      assignee: "Reviewer",
      dependsOn: ["write"],
      expectedResult: "Verified pricing",
      id: "review",
      note: "Waiting for current prices",
      status: "blocked",
      title: "Check prices",
    },
  ],
  title: "Acme proposal",
};

test("renders responsibility, verified progress and blockers with a native disclosure", () => {
  const { container } = render(<PlanCard plan={plan} />);
  expect(screen.getByText("Acme proposal")).toBeTruthy();
  expect(screen.getByText("1/3 completed")).toBeTruthy();
  expect(screen.getByText("Sources checked")).toBeTruthy();
  expect(screen.getByText("In progress · This bot")).toBeTruthy();
  expect(screen.getByText("Waiting for current prices")).toBeTruthy();
  expect(
    screen.getByRole("list", { name: "Plan steps" }).children
  ).toHaveLength(3);
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.querySelector("summary")).toBeTruthy();
});

test("shows interruption without claiming the unfinished step is still running", () => {
  render(<PlanCard paused plan={plan} />);
  expect(screen.getByText("Paused · This bot")).toBeTruthy();
  expect(screen.queryByText("In progress · This bot")).toBeNull();
});

test("keeps agent text as text when rendering a plan", () => {
  const { container } = render(
    <PlanCard plan={{ ...plan, title: "<script>run()</script>" }} />
  );
  expect(screen.getByText("<script>run()</script>")).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
});

test("renders failed execution as attention without claiming completion", () => {
  render(
    <PlanCard
      plan={{
        ...plan,
        steps: [
          {
            ...plan.steps[0],
            note: "Delegated task failed: child crashed",
            status: "failed",
          },
          ...plan.steps.slice(1),
        ],
      }}
    />
  );
  expect(screen.getByText("0/3 completed · Needs attention")).toBeTruthy();
  expect(screen.getByText("Failed · Researcher")).toBeTruthy();
  expect(screen.queryByText("Completed · Researcher")).toBeNull();
});

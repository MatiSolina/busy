import { z } from "zod";
import {
  PLAN_DISPATCH_LIMIT,
  PLAN_EXECUTION_KINDS,
  PLAN_EXECUTION_STATUSES,
  PLAN_STEP_ID,
  PLAN_STEP_STATUSES,
  planStepProblems,
} from "./task-plan";

const stepId = z.string().regex(PLAN_STEP_ID);
const executionOwnerSchema = z
  .object({
    callId: z.string().trim().min(1).max(200).optional(),
    principalId: z.string().trim().min(1).max(300).optional(),
    sessionId: z.string().trim().min(1).max(200),
    turnId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const planExecutionSchema = z
  .object({
    callId: z.string().trim().min(1).max(200).optional(),
    childSessionId: z.string().trim().min(1).max(200).optional(),
    dispatchKey: z.string().trim().min(1).max(300).optional(),
    failureReason: z.string().trim().min(1).max(2000).optional(),
    id: z.string().trim().min(1).max(200),
    kind: z.enum(PLAN_EXECUTION_KINDS),
    lastEventKey: z.string().trim().min(1).max(300).optional(),
    owner: executionOwnerSchema,
    planRevision: z.number().int().positive(),
    resultEvidence: z.string().trim().min(1).max(4000).optional(),
    status: z.enum(PLAN_EXECUTION_STATUSES),
    taskId: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

export const planStepSchema = z
  .object({
    assignee: z.string().trim().min(1).max(100),
    dependsOn: z.array(stepId).max(20),
    execution: planExecutionSchema.optional(),
    expectedResult: z.string().trim().min(1).max(1000),
    id: stepId,
    note: z.string().trim().min(1).max(2000).optional(),
    status: z.enum(PLAN_STEP_STATUSES),
    taskId: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(240),
  })
  .strict();

export const planStepsSchema = z
  .array(planStepSchema)
  .min(1)
  .max(20)
  .superRefine((steps, ctx) => {
    if (steps.length > 20) {
      return;
    }
    for (const message of planStepProblems(steps)) {
      ctx.addIssue({ code: "custom", message });
    }
  });

export const taskPlanSchema = z
  .object({
    dispatchCount: z.number().int().min(0).max(PLAN_DISPATCH_LIMIT).optional(),
    id: z.string().min(1).max(100),
    revision: z.number().int().positive(),
    steps: planStepsSchema,
    title: z.string().trim().min(1).max(200),
  })
  .strict();

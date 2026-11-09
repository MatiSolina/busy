"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useState } from "react";
import { useAiConnectionOptional } from "@/components/ai-connection-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type AiIssue, aiIssueGuidance } from "@/lib/ai/errors";

const AiConnectionSettings = dynamic(
  () =>
    import("@/components/ai-connection-settings").then(
      (m) => m.AiConnectionSettings
    ),
  { loading: () => <p role="status">Loading AI connections…</p> }
);

const MODEL_ISSUES = new Set([
  "invalid_model",
  "model_unavailable",
  "subscription_model_unavailable",
]);
const CONNECTION_ISSUES = new Set([
  "access_denied",
  "connection_expired",
  "connection_not_connected",
  "provider_auth_failed",
  "provider_access_denied",
  "provider_unconfigured",
  "subscription_not_selected",
]);

/** Recovery changes are explicit: a failed turn is never replayed by this card. */
export function AiIssueNotice({
  issue,
  onConfigureBot,
  modelSettings = "bot",
}: {
  issue: AiIssue;
  onConfigureBot?: () => void;
  modelSettings?: "account" | "bot";
}) {
  const connection = useAiConnectionOptional();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const modelIssue = MODEL_ISSUES.has(issue.code);
  const openConnections = useCallback(() => {
    setSettingsOpen(true);
    connection?.refresh().catch(() => undefined);
  }, [connection]);

  return (
    <div className="flex flex-col items-start gap-2 text-sm">
      <div className="text-destructive" role="alert">
        <p>{issue.message}</p>
        <p>
          {modelIssue && modelSettings === "account"
            ? "Choose another model in AI connection settings."
            : aiIssueGuidance(issue)}
        </p>
      </div>
      {issue.code === "unauthorized" ? (
        <Link
          className="underline underline-offset-4"
          href="/login"
          rel="noreferrer"
          target="_blank"
        >
          Sign in to Busy
        </Link>
      ) : null}
      {issue.code === "unauthorized" ? (
        <p className="text-muted-foreground text-xs">
          Use the new tab to sign in, then return here to keep your message.
        </p>
      ) : null}
      {modelIssue && onConfigureBot ? (
        <Button
          onClick={onConfigureBot}
          size="sm"
          type="button"
          variant="outline"
        >
          Open bot settings
        </Button>
      ) : null}
      {(CONNECTION_ISSUES.has(issue.code) ||
        (modelIssue && modelSettings === "account")) &&
      connection ? (
        <Button
          onClick={openConnections}
          size="sm"
          type="button"
          variant="outline"
        >
          Open AI connections
        </Button>
      ) : null}
      {issue.code === "provider_quota_exceeded" ? (
        <UsageAction provider={issue.provider} />
      ) : null}
      {settingsOpen ? (
        <Dialog onOpenChange={setSettingsOpen} open>
          <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>AI connections</DialogTitle>
              <DialogDescription>
                {
                  "Reconnect your account here. To change an existing bot's model or connection, open that bot's settings."
                }
              </DialogDescription>
            </DialogHeader>
            <AiConnectionSettings />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function UsageAction({ provider }: { provider: AiIssue["provider"] }) {
  const usageUrls = {
    chatgpt: "https://chatgpt.com/settings/usage",
    grok: "https://grok.com/dashboard",
  };
  const url =
    provider === "chatgpt" || provider === "grok" ? usageUrls[provider] : null;
  return url ? (
    <a
      className="underline underline-offset-4"
      href={url}
      rel="noreferrer"
      target="_blank"
    >
      Check usage
    </a>
  ) : null;
}

"use client";

import { Check, Clipboard, ExternalLink, LoaderCircle } from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type OAuthProvider = "github" | "google";

export interface ProviderSetupDetails {
  clientId: string | null;
  configured: boolean;
  docsUrl: string;
  provider: OAuthProvider;
  redirectUri: string;
  setupUrl: string;
  version: string | null;
}

interface Props {
  onOpenChange: (open: boolean) => void;
  onSaved: (details: ProviderSetupDetails) => void | Promise<void>;
  open: boolean;
  provider: OAuthProvider | null;
}

const providerName = (provider: OAuthProvider) =>
  provider === "github" ? "GitHub" : "Google";

/** Configure one global OAuth client without ever reading a stored secret back. */
type ProviderApiData = Partial<ProviderSetupDetails> & { error?: unknown };

function providerUrl(provider: OAuthProvider): string {
  return `/api/mcp/providers/${provider}`;
}

function providerError(data: ProviderApiData | null, fallback: string): string {
  return typeof data?.error === "string" ? data.error : fallback;
}

function parseProviderDetails(
  response: Response,
  data: ProviderApiData | null,
  provider: OAuthProvider,
  fallback: string
): ProviderSetupDetails {
  if (!(response.ok && data) || typeof data.redirectUri !== "string") {
    throw new Error(providerError(data, fallback));
  }
  return {
    clientId: typeof data.clientId === "string" ? data.clientId : null,
    configured: data.configured === true,
    docsUrl: typeof data.docsUrl === "string" ? data.docsUrl : "",
    provider,
    redirectUri: data.redirectUri,
    setupUrl: typeof data.setupUrl === "string" ? data.setupUrl : "",
    version: typeof data.version === "string" ? data.version : null,
  };
}

export function McpProviderSetup({
  provider,
  open,
  onOpenChange,
  onSaved,
}: Props) {
  const [details, setDetails] = useState<ProviderSetupDetails | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const requestGeneration = useRef(0);

  const loadDetails = useCallback(async () => {
    if (!provider) {
      return;
    }
    requestGeneration.current += 1;
    const generation = requestGeneration.current;
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const response = await fetch(providerUrl(provider));
      const data = (await response
        .json()
        .catch(() => null)) as ProviderApiData | null;
      if (generation !== requestGeneration.current) {
        return;
      }
      const next = parseProviderDetails(
        response,
        data,
        provider,
        `Couldn't load ${providerName(provider)} setup.`
      );
      setDetails(next);
      setClientId(next.clientId ?? "");
      setClientSecret("");
    } catch (cause: unknown) {
      if (generation !== requestGeneration.current) {
        return;
      }
      setError(
        cause instanceof Error
          ? cause.message
          : `Couldn't load ${providerName(provider)} setup.`
      );
    } finally {
      if (generation === requestGeneration.current) {
        setLoading(false);
      }
    }
  }, [provider]);

  useEffect(() => {
    if (!(open && provider)) {
      return;
    }
    let active = true;
    queueMicrotask(() => {
      if (active) {
        loadDetails();
      }
    });
    return () => {
      active = false;
      requestGeneration.current += 1;
    };
  }, [open, provider, loadDetails]);

  const save = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!(provider && details)) {
        return;
      }
      const nextClientId = clientId.trim();
      const nextSecret = clientSecret;
      if (!nextClientId) {
        setError("Enter the OAuth client ID.");
        return;
      }
      if (!(details.configured || nextSecret.trim())) {
        setError("Enter the client secret for the first setup.");
        return;
      }

      setSaving(true);
      setError(null);
      try {
        const response = await fetch(providerUrl(provider), {
          body: JSON.stringify({
            clientId: nextClientId,
            clientSecret: nextSecret,
          }),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        });
        const data = (await response
          .json()
          .catch(() => null)) as ProviderApiData | null;
        const saved = parseProviderDetails(
          response,
          data,
          provider,
          `Couldn't save ${providerName(provider)} setup.`
        );
        const normalizedSaved: ProviderSetupDetails = {
          ...saved,
          clientId: saved.clientId ?? nextClientId,
        };
        setDetails(normalizedSaved);
        setClientSecret("");
        await onSaved(normalizedSaved);
      } catch (cause: unknown) {
        setError(
          cause instanceof Error
            ? cause.message
            : `Couldn't save ${providerName(provider)} setup.`
        );
      } finally {
        setSaving(false);
      }
    },
    [clientId, clientSecret, details, onSaved, provider]
  );

  const copyRedirectUri = useCallback(async () => {
    if (!(details?.redirectUri && navigator.clipboard?.writeText)) {
      setError("Copy is unavailable here. Select the callback URL manually.");
      return;
    }
    try {
      await navigator.clipboard.writeText(details.redirectUri);
      setCopied(true);
    } catch {
      setError("Copy is unavailable here. Select the callback URL manually.");
    }
  }, [details]);

  const handleClientIdChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setClientId(event.target.value),
    []
  );
  const handleClientSecretChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setClientSecret(event.target.value),
    []
  );
  const handleCancel = useCallback(() => onOpenChange(false), [onOpenChange]);
  const name = provider ? providerName(provider) : "OAuth";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[min(90dvh,720px)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up {name}</DialogTitle>
          <DialogDescription>
            Register Busy as an OAuth app, add this callback URL, then paste the
            credentials here. The setup applies to every bot that uses {name}.
          </DialogDescription>
        </DialogHeader>
        <ProviderSetupBody
          clientId={clientId}
          clientSecret={clientSecret}
          copied={copied}
          copyRedirectUri={copyRedirectUri}
          details={details}
          error={error}
          handleClientIdChange={handleClientIdChange}
          handleClientSecretChange={handleClientSecretChange}
          loading={loading}
          name={name}
          onCancel={handleCancel}
          onSubmit={save}
          provider={provider}
          saving={saving}
        />
      </DialogContent>
    </Dialog>
  );
}

function ProviderSetupBody({
  clientId,
  clientSecret,
  copied,
  copyRedirectUri,
  details,
  error,
  handleClientIdChange,
  handleClientSecretChange,
  loading,
  name,
  onCancel,
  onSubmit,
  provider,
  saving,
}: {
  clientId: string;
  clientSecret: string;
  copied: boolean;
  copyRedirectUri: () => void;
  details: ProviderSetupDetails | null;
  error: string | null;
  handleClientIdChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleClientSecretChange: (event: ChangeEvent<HTMLInputElement>) => void;
  loading: boolean;
  name: string;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  provider: OAuthProvider | null;
  saving: boolean;
}) {
  if (loading) {
    return (
      <div
        className="text-muted-foreground flex items-center gap-2 py-8 text-sm"
        role="status"
      >
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
        Loading {name} setup…
      </div>
    );
  }
  if (details) {
    return (
      <ProviderSetupForm
        clientId={clientId}
        clientSecret={clientSecret}
        copied={copied}
        copyRedirectUri={copyRedirectUri}
        details={details}
        error={error}
        handleClientIdChange={handleClientIdChange}
        handleClientSecretChange={handleClientSecretChange}
        name={name}
        onCancel={onCancel}
        onSubmit={onSubmit}
        provider={provider ?? details.provider}
        saving={saving}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3 py-4" role="alert">
      <p className="text-destructive text-sm">
        {error ?? `Couldn't load ${name} setup.`}
      </p>
      <Button onClick={onCancel} variant="outline">
        Close
      </Button>
    </div>
  );
}

function ProviderSetupForm({
  clientId,
  clientSecret,
  copied,
  copyRedirectUri,
  details,
  error,
  handleClientIdChange,
  handleClientSecretChange,
  name,
  onCancel,
  onSubmit,
  provider,
  saving,
}: {
  clientId: string;
  clientSecret: string;
  copied: boolean;
  copyRedirectUri: () => void;
  details: ProviderSetupDetails;
  error: string | null;
  handleClientIdChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleClientSecretChange: (event: ChangeEvent<HTMLInputElement>) => void;
  name: string;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  provider: OAuthProvider;
  saving: boolean;
}) {
  const callbackId = `mcp-${provider}-callback`;
  const callbackHelpId = `mcp-${provider}-callback-help`;
  const clientIdInputId = `mcp-${provider}-client-id`;
  const clientSecretInputId = `mcp-${provider}-client-secret`;
  const saveLabel = details.configured ? "Save credentials" : "Save setup";
  const buttonLabel = saving ? "Saving…" : saveLabel;
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {details.setupUrl ? (
          <a
            className="hover:text-foreground inline-flex items-center gap-1.5 underline underline-offset-3"
            href={details.setupUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open {name} developer settings
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        ) : null}
        {details.docsUrl ? (
          <a
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 underline underline-offset-3"
            href={details.docsUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Read the setup guide
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        ) : null}
      </div>

      {provider === "google" ? (
        <p className="border-border bg-muted/40 text-muted-foreground rounded-lg border p-3 text-[13px] leading-snug">
          Google Workspace MCP is in Developer Preview. The lft-orca-dev project
          needs preview access and each app&apos;s API/MCP services enabled.
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor={callbackId}>Callback URL</Label>
        <div className="flex gap-2">
          <Input
            aria-describedby={callbackHelpId}
            className="min-w-0 flex-1 font-mono text-xs"
            id={callbackId}
            readOnly
            value={details.redirectUri}
          />
          <Button
            onClick={copyRedirectUri}
            size="sm"
            type="button"
            variant="outline"
          >
            {copied ? <Check aria-hidden /> : <Clipboard aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs" id={callbackHelpId}>
          Add this exact URL to the OAuth app before saving.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={clientIdInputId}>OAuth client ID</Label>
        <Input
          autoComplete="off"
          id={clientIdInputId}
          onChange={handleClientIdChange}
          required
          spellCheck={false}
          value={clientId}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={clientSecretInputId}>Client secret</Label>
        <Input
          autoComplete="off"
          id={clientSecretInputId}
          onChange={handleClientSecretChange}
          placeholder={
            details.configured
              ? "Leave blank to keep the current secret"
              : undefined
          }
          required={!details.configured}
          spellCheck={false}
          type="password"
          value={clientSecret}
        />
        <p className="text-muted-foreground text-xs">
          Busy never shows a saved secret.{" "}
          {details.configured
            ? "Changing credentials requires reconnecting this provider on each bot."
            : "A client secret is required for the first setup."}
        </p>
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button
          disabled={saving}
          onClick={onCancel}
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button disabled={saving} type="submit">
          {saving ? (
            <LoaderCircle aria-hidden className="size-4 animate-spin" />
          ) : null}
          {buttonLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

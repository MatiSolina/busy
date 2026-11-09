"use client";

import { Eye, MonitorPlay, MousePointer2 } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { BotBooting } from "@/components/bot-avatar";
import { MountOnOpen } from "@/components/mount-on-open";
import { TeachControl } from "@/components/teach-control";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Mode = "observe" | "control";
interface Live {
  password: string;
  url: string;
}
interface Remote {
  blur: () => void;
  disconnect: () => void;
  sendKey: (keysym: number, code: string | null) => void;
  viewOnly: boolean;
}
// The hub keeps the computer on while these keep coming (lib/live.ts WATCH_MS is 90 s), on top of its 10 minutes.
const HEARTBEAT_MS = 30_000;
// X11 keysyms: Latin-1 maps to itself, the rest of Unicode to 0x01000000 + its code point.
const keysymOf = (ch: string) => {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 0x20 && cp <= 0xff ? cp : 0x01_00_00_00 + cp;
};
const KEYS: Record<string, number> = {
  Backspace: 0xff_08,
  Enter: 0xff_0d,
  Escape: 0xff_1b,
  Tab: 0xff_09,
};

// One preconnect per bot at a time. Preconnect opens the shared VNC connection but never acquires
// the VM's input lease; that happens through PATCH when the user explicitly chooses Take control.
type Opened = { ok: boolean; body: unknown } | null;
const opening = new Map<string, Promise<Opened>>();
function openRequest(endpoint: string): Promise<Opened> {
  let req = opening.get(endpoint);
  if (!req) {
    req = (async () => {
      const response = await fetch(endpoint, {
        body: JSON.stringify({ mode: "control" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { body, ok: response.ok };
    })()
      .catch(() => null)
      .finally(() => opening.delete(endpoint));
    opening.set(endpoint, req);
  }
  return req;
}

type Lease =
  | "watch"
  | "acquiring"
  | "control"
  | "busy"
  | "lost"
  | "unavailable";
interface LeaseBody {
  code?: string;
  error?: string;
  expiresAt?: number;
  ok: boolean;
}

// This hook is a lease state machine: each branch preserves ordering between control, release,
// expiry, and reconnect requests. Keeping it together avoids races between separate effects.
function useControlLease(endpoint: string, open: Mode | null) {
  const [viewerId] = useState(() => crypto.randomUUID());
  const [lease, setLease] = useState<Lease>("watch");
  const leaseRef = useRef<Lease>("watch");
  const mounted = useRef<boolean>(true);
  const sequence = useRef(0);
  const currentOpen = useRef<Mode | null>(null);
  const queue = useRef<Promise<unknown> | null>(null);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpSequence = useCallback(() => {
    sequence.current += 1;
    return sequence.current;
  }, []);

  const clearExpiry = useCallback(() => {
    if (expiryTimer.current !== null) {
      clearTimeout(expiryTimer.current);
      expiryTimer.current = null;
    }
  }, []);

  const updateLease = useCallback(
    (next: Lease) => {
      if (next !== "control") {
        clearExpiry();
      }
      leaseRef.current = next;
      // The queued lease request can settle after cleanup; guard the state update for that case.
      if (mounted.current) {
        setLease(next);
      }
    },
    [clearExpiry]
  );

  const enqueue = useCallback(<T,>(operation: () => Promise<T>) => {
    const run = (queue.current ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  const request = useCallback(
    async (mode: Mode) => {
      const response = await fetch(endpoint, {
        body: JSON.stringify({ mode, viewerId }),
        headers: { "Content-Type": "application/json" },
        keepalive: mode === "observe",
        method: "PATCH",
      }).catch(() => null);
      const body = (await response
        ?.json()
        .catch(() => null)) as LeaseBody | null;
      return { body, response };
    },
    [endpoint, viewerId]
  );

  const release = useCallback(
    () =>
      enqueue(async () => {
        const { response, body } = await request("observe");
        return Boolean(
          response?.ok && (body?.ok === true || body?.code === "CONTROL_LOST")
        );
      }),
    [enqueue, request]
  );

  const expire = useCallback(() => {
    if (leaseRef.current !== "control") {
      return;
    }
    bumpSequence();
    updateLease("lost");
    release();
  }, [bumpSequence, release, updateLease]);

  const armExpiry = useCallback(
    (expiresAt: number) => {
      clearExpiry();
      expiryTimer.current = setTimeout(
        expire,
        Math.max(0, expiresAt - Date.now() - 1000)
      );
    },
    [clearExpiry, expire]
  );

  const acquire = useCallback(
    (wanted: number) =>
      enqueue(async () => {
        const { response, body } = await request("control");
        // A close/watch can happen while the PATCH is in flight. The queued release is the
        // cleanup for a late grant, so stale responses never re-enable input.
        if (wanted !== sequence.current || currentOpen.current !== "control") {
          await request("observe");
          return;
        }
        if (
          response?.ok &&
          body?.ok === true &&
          typeof body.expiresAt === "number"
        ) {
          armExpiry(body.expiresAt);
          return updateLease("control");
        }
        if (body?.code === "CONTROL_BUSY") {
          updateLease("busy");
          release();
          return;
        }
        if (body?.code === "CONTROL_LOST") {
          updateLease("lost");
          release();
          return;
        }
        updateLease("unavailable");
        release();
      }),
    [armExpiry, enqueue, release, request, updateLease]
  );

  const retry = useCallback(() => {
    if (currentOpen.current !== "control") {
      return;
    }
    const wanted = bumpSequence();
    updateLease("acquiring");
    acquire(wanted);
  }, [acquire, bumpSequence, updateLease]);

  useEffect(() => {
    const was = currentOpen.current;
    currentOpen.current = open;
    if (open === null && was === null) {
      return;
    }
    const wanted = bumpSequence();
    if (open === "control") {
      updateLease("acquiring");
      acquire(wanted);
    } else {
      updateLease("watch");
      release();
    }
  }, [acquire, bumpSequence, open, release, updateLease]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      currentOpen.current = null;
      bumpSequence();
      clearExpiry();
      release();
    };
  }, [bumpSequence, clearExpiry, release]);

  useEffect(() => {
    if (!open) {
      return;
    }
    // Heartbeats intentionally combine lease renewal, expiry, and stale-response handling.
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: heartbeat state transitions must stay atomic
    const beat = async () => {
      const wanted = sequence.current;
      const controlling = leaseRef.current === "control";
      const body = controlling ? { viewerId } : undefined;
      const response = await fetch(endpoint, {
        body: body ? JSON.stringify(body) : undefined,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        method: "PUT",
      }).catch(() => null);
      const result = (await response
        ?.json()
        .catch(() => null)) as LeaseBody | null;
      const current =
        wanted === sequence.current &&
        currentOpen.current === "control" &&
        leaseRef.current === "control";
      if (
        body &&
        current &&
        response?.ok &&
        result?.ok === true &&
        typeof result.expiresAt === "number"
      ) {
        armExpiry(result.expiresAt);
      }
      if (
        body &&
        current &&
        (!response?.ok ||
          result?.ok !== true ||
          typeof result.expiresAt !== "number")
      ) {
        bumpSequence();
        updateLease(response?.status === 409 ? "lost" : "unavailable");
        release();
      }
    };
    beat();
    const id = setInterval(() => beat(), HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [armExpiry, bumpSequence, open, release, endpoint, updateLease, viewerId]);

  const lost = useCallback(() => {
    bumpSequence();
    if (leaseRef.current === "control" || currentOpen.current === "control") {
      updateLease("lost");
    }
    release();
  }, [bumpSequence, release, updateLease]);

  const finishLogin = useCallback(() => {
    bumpSequence();
    updateLease("watch");
    return release();
  }, [bumpSequence, release, updateLease]);

  return { finishLogin, lease, lost, retry };
}

// loggingIn: the bot's turn is paused on a login card (request_login), waiting for the user, not working.
type LoginDone = () => Promise<boolean> | boolean | undefined;
interface Props {
  avatar?: string | null;
  embedded?: boolean;
  endpoint?: string;
  loggingIn: boolean;
  name: string;
  onLoginDone?: LoginDone;
  /** Teach: sends the bot the message about a finished recording. Without it, no Teach control. */
  onTeachDone?: (message: string) => void;
  slug: string;
  working: boolean;
}

/**
 * The bot's computer, live, as in Grok Bot: watch it work, or take the mouse and keyboard. `open` is the
 * mode it opens in (the chat's login card opens it in control), null when closed.
 */
export function LiveView({
  open,
  onOpenChange,
  hideTrigger = false,
  ...props
}: Props & {
  open: Mode | null;
  onOpenChange: (open: Mode | null) => void;
  hideTrigger?: boolean;
}) {
  const { slug, onLoginDone: answerLogin } = props;
  const {
    lease,
    retry,
    lost,
    finishLogin: releaseControl,
  } = useControlLease(
    props.endpoint ?? `/api/bots/${encodeURIComponent(slug)}/live`,
    open
  );
  const finishLogin = useCallback(async () => {
    if (!(await releaseControl())) {
      return false;
    }
    onOpenChange("observe");
    const answered = answerLogin ? await answerLogin() : true;
    return answered !== false;
  }, [answerLogin, onOpenChange, releaseControl]);
  // One connection per attempt. A dropped or refused one is replaced only when the user retries
  // or when a turn wakes the computer (it was off).
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [wasWorking, setWasWorking] = useState(props.working);
  const retryConnection = useCallback(() => {
    setFailed(false);
    setAttempt((a) => a + 1);
  }, []);
  const handleWatch = useCallback(
    () => onOpenChange("observe"),
    [onOpenChange]
  );
  const handleDialogChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        onOpenChange(null);
      }
    },
    [onOpenChange]
  );
  const handleRetry = useCallback(() => {
    if (failed) {
      retryConnection();
    }
    if (open === "control" && lease !== "control") {
      retry();
    }
  }, [failed, lease, open, retry, retryConnection]);
  if (props.working !== wasWorking) {
    setWasWorking(props.working);
    if (props.working && failed) {
      retryConnection();
    }
  }
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && failed) {
      retryConnection();
    }
  }
  const screen = (
    <LiveScreen
      key={`${slug}:${attempt}`}
      {...props}
      lease={lease}
      onConnectionLost={lost}
      onFailed={setFailed}
      onLoginDone={finishLogin}
      onRequestMode={onOpenChange}
      onRetry={handleRetry}
      open={open}
    />
  );
  if (props.embedded) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {screen}
      </div>
    );
  }
  return (
    <>
      {hideTrigger ? null : (
        <Button
          aria-label="Watch live"
          className="text-muted-foreground"
          onClick={handleWatch}
          size="sm"
          variant="ghost"
        >
          <MonitorPlay aria-hidden="true" />
          <span className="hidden sm:inline">Live</span>
        </Button>
      )}
      <Dialog onOpenChange={handleDialogChange} open={open !== null}>
        {/* Full screen on a phone, upright or sideways (the remote screen gets the space); a card where there's room.
            The card's width also follows the window's height, so the 16:10 screen plus ~10rem of header and margins fits without scrolling. */}
        <DialogContent
          className="roomy:h-auto roomy:max-h-[calc(100dvh-2rem)] roomy:w-full roomy:max-w-[min(1120px,calc(100%-4rem),calc((100dvh-10rem)*1.6+2rem))] roomy:rounded-xl roomy:p-4 flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-3 rounded-none p-3 sm:max-w-none"
          keepMounted
        >
          <MountOnOpen open={open !== null}>{screen}</MountOnOpen>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface ScreenProps extends Props {
  lease: Lease;
  onConnectionLost: () => void;
  onFailed: (failed: boolean) => void;
  onRequestMode: (mode: Mode | null) => void;
  onRetry: () => void;
  open: Mode | null;
}

function leaseStatusText(lease: Lease): string | null {
  if (lease === "acquiring") {
    return "Requesting control…";
  }
  if (lease === "busy") {
    return "Another window is controlling this computer.";
  }
  if (lease === "lost") {
    return "Control ended. You can keep watching or try again.";
  }
  if (lease === "unavailable") {
    return "Control is unavailable in this computer image.";
  }
  return null;
}

function screenStatusText(
  state: "waking" | "connecting" | "live" | "error",
  error: string | null,
  leaseStatus: string | null,
  mode: Mode,
  loggingIn: boolean,
  working: boolean,
  name: string
): string | null {
  if (state === "error") {
    return error;
  }
  if (leaseStatus) {
    return leaseStatus;
  }
  if (state === "waking") {
    return "Clanker starting…";
  }
  if (state === "connecting") {
    return "Clanker connecting…";
  }
  if (mode === "control") {
    if (loggingIn) {
      return `Log in, then tap Done below: ${name} goes on from there.`;
    }
    return working
      ? "You're in control. The bot is waiting."
      : `You're in control. ${name} won't do anything until you message it.`;
  }
  if (loggingIn) {
    return `${name} is waiting for you to log in. Take control to do it.`;
  }
  return working
    ? `Watching ${name} work.`
    : `${name} is idle. You can watch or take control.`;
}

function controlButtonLabel(lease: Lease): string {
  if (lease === "busy" || lease === "lost" || lease === "unavailable") {
    return "Try again";
  }
  if (lease === "acquiring") {
    return "Requesting…";
  }
  return "Take control";
}

function liveTypography(embedded: boolean) {
  return embedded
    ? { Description: "p" as const, Title: "h3" as const }
    : { Description: DialogDescription, Title: DialogTitle };
}

// This component coordinates the VNC lifecycle, lease overlay, login handoff, and keyboard bridge.
function LiveScreen({
  embedded = false,
  slug,
  endpoint = `/api/bots/${encodeURIComponent(slug)}/live`,
  name,
  avatar,
  working,
  loggingIn,
  onLoginDone,
  onTeachDone,
  open,
  lease,
  onFailed,
  onConnectionLost,
  onRetry,
  onRequestMode,
}: ScreenProps) {
  const screen = useRef<HTMLDivElement>(null);
  const remote = useRef<Remote | null>(null);
  const sendKey = useCallback((keysym: number) => {
    remote.current?.sendKey(keysym, null);
  }, []);
  // waking: the hub wakes (or first creates) the computer; connecting: its screen is on the way.
  const [state, setState] = useState<
    "waking" | "connecting" | "live" | "error"
  >("waking");
  const [error, setError] = useState<string | null>(null);
  const [answeringLogin, setAnsweringLogin] = useState(false);
  const [loginAnswerFailed, setLoginAnswerFailed] = useState(false);
  const connectionLost = useEffectEvent(onConnectionLost);
  useEffect(() => {
    let live = true;
    let rfb: Remote | null = null;
    const failed = (message: string) => {
      if (!live) {
        return;
      }
      setState("error");
      setError(message);
      onFailed(true);
    };
    // A fresh mount per bot and attempt (its key): it starts out waking.
    (async () => {
      const opened = await openRequest(endpoint);
      if (!live) {
        return;
      }
      if (!opened) {
        return failed("Can't reach Busy.");
      }
      if (!opened.ok) {
        return failed(
          (opened.body as { error?: string } | null)?.error ??
            "Couldn't open the screen."
        );
      }
      const target = opened.body as Live;
      setState("connecting");
      // noVNC only runs in the browser: loaded on first use, not in the page bundle.
      const { default: RFB } = await import("@novnc/novnc");
      if (!(live && screen.current)) {
        return;
      }
      const client = new RFB(screen.current, target.url, {
        credentials: { password: target.password },
      });
      client.viewOnly = true;
      client.scaleViewport = true;
      client.background = "transparent";
      client.addEventListener("connect", () => live && setState("live"));
      client.addEventListener("disconnect", () => {
        if (!live) {
          return;
        }
        failed("Lost the connection to the computer.");
        connectionLost();
      });
      client.addEventListener("securityfailure", () => {
        if (!live) {
          return;
        }
        failed("The computer refused the connection.");
        connectionLost();
      });
      rfb = client;
      remote.current = client;
    })();
    return () => {
      live = false;
      rfb?.disconnect();
      remote.current = null;
    };
  }, [onFailed, endpoint]);

  // The local overlay and noVNC's viewOnly flag stay locked until the server acknowledges the lease.
  const canInteract =
    open === "control" && lease === "control" && state === "live";
  useEffect(() => {
    if (!remote.current) {
      return;
    }
    remote.current.viewOnly = !canInteract;
    if (!canInteract) {
      remote.current.blur();
    }
  }, [canInteract]);

  const booting = state === "waking" || state === "connecting";
  const mode: Mode = canInteract ? "control" : "observe";
  const leaseStatus = leaseStatusText(lease);
  const status = screenStatusText(
    state,
    error,
    leaseStatus,
    mode,
    loggingIn,
    working,
    name
  );
  const handleObserve = useCallback(
    () => onRequestMode("observe"),
    [onRequestMode]
  );
  const handleControl = useCallback(() => {
    if (lease === "busy" || lease === "lost" || lease === "unavailable") {
      onRetry();
      return;
    }
    onRequestMode("control");
  }, [lease, onRequestMode, onRetry]);
  const controlLabel = controlButtonLabel(lease);
  const handleLoginDone = useCallback(async () => {
    if (!onLoginDone || answeringLogin) {
      return;
    }
    setAnsweringLogin(true);
    setLoginAnswerFailed(false);
    const ok = await Promise.resolve(onLoginDone()).catch(() => false);
    setAnsweringLogin(false);
    if (ok !== true) {
      setLoginAnswerFailed(true);
    }
  }, [answeringLogin, onLoginDone]);

  const { Title, Description } = liveTypography(embedded);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 pr-8">
        <Title className="flex-1 font-medium">{`${name}'s computer`}</Title>
        <fieldset
          aria-label="Mode"
          className="bg-muted flex gap-1 rounded-lg p-1"
        >
          <Button
            aria-pressed={mode === "observe"}
            onClick={handleObserve}
            size="sm"
            variant={mode === "observe" ? "secondary" : "ghost"}
          >
            <Eye aria-hidden="true" />
            Watch
          </Button>
          <Button
            aria-pressed={mode === "control"}
            disabled={lease === "acquiring"}
            onClick={handleControl}
            size="sm"
            variant={mode === "control" ? "secondary" : "ghost"}
          >
            <MousePointer2 aria-hidden="true" />
            {controlLabel}
          </Button>
        </fieldset>
      </div>
      {/* While it boots the dancing bot below says it; the line stays for screen readers. */}
      <Description
        className={cn(
          (state === "error" ||
            lease === "busy" ||
            lease === "lost" ||
            lease === "unavailable") &&
            "text-destructive",
          booting && "sr-only"
        )}
        role="status"
      >
        {status}
      </Description>
      {loggingIn && (canInteract || loginAnswerFailed) ? (
        <div className="flex flex-wrap items-center gap-2 self-start">
          <Button
            disabled={!onLoginDone || answeringLogin}
            onClick={handleLoginDone}
            size="sm"
          >
            {answeringLogin ? "Sending…" : "Done logging in"}
          </Button>
          {loginAnswerFailed ? (
            <span className="text-destructive text-xs" role="alert">
              Couldn&apos;t let it know. Try again.
            </span>
          ) : null}
        </div>
      ) : null}
      <TeachControl canStart={canInteract} onDone={onTeachDone} slug={slug} />
      <p className="text-muted-foreground roomy:hidden -mt-2 text-xs landscape:hidden">
        Turn your phone sideways to see it bigger.
      </p>
      {/* A phone gives it whatever height is left (noVNC scales to fit); a big screen keeps 16:10. */}
      <div className="roomy:aspect-[1440/900] roomy:flex-none relative min-h-0 w-full flex-1 overflow-hidden rounded-lg bg-black">
        <div className="absolute inset-0" ref={screen} />
        {booting ? (
          <div
            aria-hidden="true"
            className="absolute inset-0 grid place-items-center text-white"
          >
            <BotBooting
              avatar={avatar}
              phrase={status ?? ""}
              size={112}
              slug={slug}
            />
          </div>
        ) : null}
        {/* Watching: a layer over the screen catches every tap and click, so nothing reaches the computer. */}
        {canInteract ? null : (
          <div
            aria-hidden="true"
            className="absolute inset-0 cursor-default"
            data-testid="lock"
          />
        )}
      </div>
      {canInteract ? <TypeBox onKey={sendKey} /> : null}
    </>
  );
}

/**
 * A phone's keyboard only opens for a text field, never for noVNC's canvas: in control mode, this
 * field passes each key straight to the remote computer and stays empty.
 */
function TypeBox({ onKey }: { onKey: (keysym: number) => void }) {
  const handleTypeBoxChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      for (const ch of event.currentTarget.value) {
        onKey(keysymOf(ch));
      }
      event.currentTarget.value = "";
    },
    [onKey]
  );

  const handleTypeBoxKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      const keysym = KEYS[event.key];
      if (keysym === undefined) {
        return;
      }
      event.preventDefault();
      onKey(keysym);
    },
    [onKey]
  );
  return (
    <input
      aria-label="Type on the computer"
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      className="border-input roomy:hidden h-10 w-full shrink-0 rounded-lg border bg-transparent px-3 text-base outline-none pointer-coarse:block"
      enterKeyHint="send"
      onChange={handleTypeBoxChange}
      onKeyDown={handleTypeBoxKeyDown}
      placeholder="Tap here to type on the computer"
      spellCheck={false}
    />
  );
}

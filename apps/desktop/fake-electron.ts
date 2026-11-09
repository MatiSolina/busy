// An in-memory stand-in for the parts of `electron` that main.mjs uses, for main*.test.ts.
// Each call builds a fresh app, so every test imports main.mjs against its own fake.
import { vi } from "vitest";

type Fn = (...args: unknown[]) => unknown;

export class Emitter {
  readonly listeners = new Map<string, Fn[]>();
  on(event: string, fn: Fn) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  once(event: string, fn: Fn) {
    const wrap: Fn = (...args) => {
      this.off(event, wrap);
      return fn(...args);
    };
    return this.on(event, wrap);
  }
  off(event: string, fn: Fn) {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((f) => f !== fn)
    );
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of [...(this.listeners.get(event) ?? [])]) {
      fn(...args);
    }
  }
  listenerCount(event: string) {
    return this.listeners.get(event)?.length ?? 0;
  }
}

export type OpenHandler = (details: {
  url: string;
  frameName: string;
  features: string;
  disposition: string;
}) => { action: string };

export function fakeElectron(
  opts: {
    packaged?: boolean;
    version?: string;
    lock?: boolean;
    dock?: boolean;
    paths?: Record<string, string>;
  } = {}
) {
  // Ordered record of the calls that matter for sequencing assertions.
  const calls: string[] = [];
  const windows: FakeWindow[] = [];

  class FakeWebContents extends Emitter {
    openHandler: OpenHandler | undefined;
    mainFrame = { url: "https://app.busybot.dev" };
    session = {
      fetch: vi.fn(async () => new Response("not found", { status: 404 })),
    };
    setWindowOpenHandler = vi.fn((fn: OpenHandler) => {
      this.openHandler = fn;
    });
    insertCSS = vi.fn(async (_css: string) => "css-key");
    getURL = vi.fn(() => this.mainFrame.url);
    forcefullyCrashRenderer = vi.fn(() => calls.push("crash renderer"));
  }

  class FakeWindow extends Emitter {
    static getAllWindows = vi.fn(() => windows.filter((w) => !w.closed));
    closed = false;
    minimized = false;
    webContents = new FakeWebContents();
    show = vi.fn(() => calls.push("show"));
    loadURL = vi.fn((url: string) => {
      calls.push(`loadURL ${url}`);
      // What getURL() reports from now on; a test emits did-finish-load / did-fail-load itself.
      this.webContents.mainFrame = { url };
      return Promise.resolve();
    });
    isMinimized = vi.fn(() => this.minimized);
    restore = vi.fn(() => {
      this.minimized = false;
      calls.push("restore");
    });
    focus = vi.fn(() => calls.push("focus"));
    readonly options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      windows.push(this);
      calls.push("new BrowserWindow");
    }
  }

  let ready!: () => void;
  const whenReady = new Promise<void>((resolve) => {
    ready = resolve;
  });

  const app = Object.assign(new Emitter(), {
    dock: opts.dock === false ? undefined : { setIcon: vi.fn() },
    exit: vi.fn((code?: number) => calls.push(`exit ${code}`)),
    getPath: vi.fn(
      (name: string) => opts.paths?.[name] ?? `/nonexistent/busy-test/${name}`
    ),
    getVersion: vi.fn(() => opts.version ?? "0.2.0"),
    isPackaged: opts.packaged ?? true,
    quit: vi.fn(() => calls.push("quit")),
    requestSingleInstanceLock: vi.fn(() => opts.lock ?? true),
    whenReady: vi.fn(() => whenReady),
  });

  const perms: { request?: Fn; check?: Fn } = {};
  const session = {
    defaultSession: {
      setPermissionCheckHandler: vi.fn((fn: Fn) => {
        perms.check = fn;
        calls.push("setPermissionCheckHandler");
      }),
      setPermissionRequestHandler: vi.fn((fn: Fn) => {
        perms.request = fn;
        calls.push("setPermissionRequestHandler");
      }),
    },
  };
  const shell = {
    openExternal: vi.fn((_url: string) => Promise.resolve()),
  };
  const ipcMain = {
    handle: vi.fn((_channel: string, _handler: Fn) => undefined),
  };
  const dialog = {
    showErrorBox: vi.fn((_title: string, _content: string) => {
      calls.push("showErrorBox");
    }),
    showMessageBox: vi.fn((_opts: Record<string, unknown>) => {
      calls.push("showMessageBox");
      return Promise.resolve({ checkboxChecked: false, response: 1 });
    }),
  };
  const net = {
    fetch: vi.fn((url: string): Promise<Response> => {
      calls.push(`fetch ${url}`);
      return Promise.resolve(new Response("not found", { status: 404 }));
    }),
  };

  return {
    app,
    BrowserWindow: FakeWindow,
    calls,
    dialog,
    ipcMain,
    module: {
      app,
      BrowserWindow: FakeWindow,
      dialog,
      ipcMain,
      net,
      session,
      shell,
    },
    net,
    perms,
    ready,
    session,
    shell,
    windows,
  };
}

export type FakeElectron = ReturnType<typeof fakeElectron>;

/** Let promise chains (and anything queued behind a macrotask) run to completion. */
export async function flush(rounds = 8): Promise<void> {
  if (rounds <= 0) {
    return;
  }
  await new Promise((resolve) => setImmediate(resolve));
  await flush(rounds - 1);
}

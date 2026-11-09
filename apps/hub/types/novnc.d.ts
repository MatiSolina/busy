// The slice of noVNC's RFB client (1.7, no bundled types) that components/live-view.tsx uses.
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      url: string,
      options?: { credentials?: { password?: string } }
    );
    viewOnly: boolean;
    scaleViewport: boolean;
    background: string;
    disconnect(): void;
    blur(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
  }
}

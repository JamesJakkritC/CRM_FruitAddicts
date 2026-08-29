/** LINE messaging + auth, behind an interface so the app never imports the SDK
 *  directly. Swap the implementation via LINE_PROVIDER without touching callers. */
export interface LineMessage {
  type: string;
  text?: string;
  [k: string]: unknown;
}

/** A tappable region of a rich menu (LINE Messaging API shape). */
export interface RichMenuArea {
  bounds: { x: number; y: number; width: number; height: number };
  action: { type: 'uri' | 'message' | 'postback'; label?: string; uri?: string; text?: string; data?: string };
}

/** A rich menu definition as the LINE API expects it (minus the image). */
export interface RichMenuSpec {
  size: { width: number; height: number };
  selected: boolean;
  name: string;         // internal name, <= 300 chars
  chatBarText: string;  // label on the menu bar, <= 14 chars
  areas: RichMenuArea[];
}

export interface LineProvider {
  readonly name: string;
  /** Deliver push messages to a LINE user. Mock provider is a no-op network-wise. */
  pushMessage(to: string, messages: LineMessage[]): Promise<void>;
  /** Verify a LIFF ID token; returns the LINE user id (sub) or null. */
  verifyIdToken(idToken: string): Promise<string | null>;
  /** Verify an inbound webhook signature (X-Line-Signature). */
  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean;

  // --- Rich menu (LINE-side artifact managed from the console) --------------
  /** Create a rich menu; returns the LINE richMenuId. */
  createRichMenu(spec: RichMenuSpec): Promise<string>;
  /** Upload the rich menu image (jpeg/png) for a richMenuId. */
  uploadRichMenuImage(richMenuId: string, image: Buffer, mime: string): Promise<void>;
  /** Set a rich menu as the default for all users. */
  setDefaultRichMenu(richMenuId: string): Promise<void>;
  /** Delete a rich menu by richMenuId (no-op if it no longer exists). */
  deleteRichMenu(richMenuId: string): Promise<void>;
}

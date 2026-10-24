/**
 * The card format.
 *
 * A card is DATA a client draws, never markup. Every card has the same
 * envelope whoever made it, so a client needs one parser and one frame, and a
 * text-only channel needs one fallback rule. Anything that needs real HTML is
 * an artifact, which a client runs sandboxed; it is never a card.
 *
 * The envelope is versioned by `kyb`. A client that does not know a card's
 * type still draws its `text` in a plain frame, so adding a type never
 * produces a blank in an older app.
 */

/** The envelope version this package reads and writes. */
export const CARD_VERSION = 1;

/** Something a person can do from a card. Exactly one of `url`, `artifact` or `say` is set. */
export interface CardAction {
  label: string;
  /** Open this address in the browser. */
  url?: string;
  /** Open one of the agent's artifacts by id. */
  artifact?: string;
  /** Send this sentence as the person's next message. Never sent without the person pressing it. */
  say?: string;
  /** Draw it as the main button. One per card at most. */
  primary?: boolean;
}

/** Whether a change is good news, bad news, or neither. Up is not always good. */
export type Tone = "good" | "bad" | "neutral";

export interface StatTile {
  label: string;
  /** Already formatted, e.g. "12,480" or "2.5%". */
  value: string;
  /** Already formatted, e.g. "+8%" or "−0.1 pt". */
  change?: string;
  tone?: Tone;
}

export interface StatsData {
  tiles: StatTile[];
}

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartData {
  kind: "line" | "bar" | "area";
  /** One label per point, shared by every series. */
  x: string[];
  /** Up to four; clients draw them in ink and greys, not colours. */
  series: ChartSeries[];
  /** Appended to values in fallbacks and tooltips, e.g. "%" or " visitors". */
  unit?: string;
}

export interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
}

export type TableCell = string | number | null;

export interface TableData {
  columns: TableColumn[];
  rows: Record<string, TableCell>[];
  /** The full row count when `rows` is a cut; clients offer the rest as an artifact. */
  total?: number;
}

export type ChecklistState = "done" | "waiting" | "failed" | "skipped";

export interface ChecklistData {
  items: { text: string; state: ChecklistState; detail?: string }[];
}

export interface BriefData {
  /** A person or company. */
  name: string;
  subtitle?: string;
  /** One or two characters for the tile; defaults to the name's first letter. */
  initial?: string;
  points?: string[];
  facts?: { label: string; value: string }[];
  tiles?: StatTile[];
}

export interface LinkData {
  url: string;
  title?: string;
  site?: string;
  description?: string;
  /** A preview image, by URL. */
  image?: string;
}

export interface ScreenshotData {
  /** The image, by URL. A path starting with "/" is on the agent's own address. */
  image: string;
  caption?: string;
  /** The page it shows, e.g. "store.example/checkout". */
  site?: string;
  /** ISO 8601. */
  takenAt?: string;
  width?: number;
  height?: number;
}

export interface FileData {
  url: string;
  name: string;
  /** Bytes. */
  size?: number;
  mediaType?: string;
}

export interface ArtifactData {
  artifactId: string;
  version?: number;
  /** Inline artifacts draw in the conversation up to a height cap; documents show a preview and Open. */
  display?: "inline" | "document";
  format?: "html" | "markdown";
  /** ISO 8601. */
  updatedAt?: string;
  /**
   * A share link to this version that anyone holding it can open. Set when
   * the artifact was posted into a shared conversation (a Buzz channel), which
   * deliberately shares it with everyone there.
   */
  url?: string;
}

export type CheckState = "passed" | "failed" | "running";

export interface PullRequestData {
  repo: string;
  number: number;
  title: string;
  url: string;
  summary?: string;
  additions?: number;
  deletions?: number;
  checks?: { name: string; state: CheckState; detail?: string }[];
  /** A few lines of the change, each starting with "+", "-" or " ". */
  diff?: { file: string; lines: string[] };
  preview?: string;
  reviewer?: string;
}

export interface ReceiptData {
  merchant: string;
  /** Minor units (cents), like the payments package. */
  amount: number;
  currency: string;
  orderId?: string;
  file?: { url: string; name: string };
  note?: string;
}

export interface RememberedData {
  fact: string;
  memoryId?: string;
}

/** What an approval asks the person to let through. */
export type ApprovalKind = "email" | "event" | "message" | "action";

/**
 * A tool call waiting for a yes, drawn as the thing itself.
 *
 * Built by a client from eve's approval request, which carries the tool's real
 * input, so "Allow gmail send?" becomes the email: who it goes to, the subject
 * and the body. `subject` is an email's subject or an event's title.
 */
export interface ApprovalData {
  kind: ApprovalKind;
  /** The tool asking, as eve names it. */
  tool: string;
  /** What the person lets happen, in a few words: "Send email", "Create event". */
  action: string;
  /** The service it acts in, e.g. "Gmail". */
  service?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  /** An event's start and end, as the tool gave them. */
  when?: string;
  until?: string;
  where?: string;
  people?: string[];
  /** Where a chat message goes, e.g. "#sales". */
  channel?: string;
  /** Anything else worth reading before saying yes, as label and value. */
  fields?: { label: string; value: string }[];
}

export type FormFieldKind = "text" | "long" | "number" | "date" | "email" | "choice";

export interface FormField {
  /** The key the answer comes back under. */
  id: string;
  label: string;
  kind: FormFieldKind;
  /** The choices, for a `choice` field. */
  options?: string[];
  required?: boolean;
  placeholder?: string;
  /** A value to start from. */
  value?: string;
}

/** A question with fields. It arrives as a `[kyb:card]` ask; the client answers with `formAnswer`. */
export interface FormData {
  fields: FormField[];
  /** The button's label. "Send" when absent. */
  submit?: string;
}

export interface RoutineData {
  name: string;
  /** In words: "Every Monday at 9:00 AM". */
  schedule: string;
  /** ISO 8601. */
  nextRun?: string;
  /** Where each run posts. */
  posts?: string[];
  /** The 5-field cron the scheduler runs, so a client can say it in the reader's own time zone. */
  cron?: string;
  /** The host's UTC offset in minutes when the routine next runs (cron runs in host time). */
  offset?: number;
}

/** Every type this version knows, with its data. */
export interface CardDataByType {
  stats: StatsData;
  chart: ChartData;
  table: TableData;
  checklist: ChecklistData;
  brief: BriefData;
  link: LinkData;
  screenshot: ScreenshotData;
  file: FileData;
  artifact: ArtifactData;
  "pull-request": PullRequestData;
  receipt: ReceiptData;
  remembered: RememberedData;
  routine: RoutineData;
  approval: ApprovalData;
  form: FormData;
}

export type KnownCardType = keyof CardDataByType;

interface Envelope {
  kyb: typeof CARD_VERSION;
  /** Set when a later card should replace this one in place, e.g. a status change. */
  id?: string;
  title?: string;
  /** The label at the card's top right: where the data came from. */
  source?: string;
  actions?: CardAction[];
  /** The plain-text version for channels that cannot draw cards. Filled by `cardText` when absent. */
  text?: string;
}

/** A card of a type this package knows. */
export type KnownCard = {
  [T in KnownCardType]: Envelope & { card: T; data: CardDataByType[T] };
}[KnownCardType];

/** A card of a type this package does not know: a client draws its `text`. */
export interface UnknownCard extends Envelope {
  card: string;
  data?: unknown;
}

export type Card = KnownCard | UnknownCard;

export const KNOWN_CARD_TYPES: readonly KnownCardType[] = [
  "stats",
  "chart",
  "table",
  "checklist",
  "brief",
  "link",
  "screenshot",
  "file",
  "artifact",
  "pull-request",
  "receipt",
  "remembered",
  "routine",
  "approval",
  "form",
];

export function isKnownCard(card: Card): card is KnownCard {
  return (KNOWN_CARD_TYPES as readonly string[]).includes(card.card);
}

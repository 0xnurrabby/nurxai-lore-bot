// The shape NurXai stores, mirrored here so the bot can build one.
//
// This is a client-side copy for construction and a usability check only. It is
// not a security boundary and does not pretend to be one: NurXai re-validates
// and clamps everything in `parseEntityIntel`, because the record is assembled
// from a document a model was asked to read and that document is untrusted.

export type EntityType = "protocol" | "company" | "person" | "token" | "event" | "narrative" | "other";

export type EntitySentiment = "bullish" | "bearish" | "outrage" | "troll" | "neutral" | "mixed";

export type StateEntry = {
  label: string;
  detail: string;
  asOf: string | null;
  confidence: number;
  sources: string[];
};

export type TimelineEntry = {
  occurredOn: string | null;
  title: string;
  detail: string;
  category: string;
  importance: number;
  confidence: number;
  sources: string[];
};

export type TeamMember = {
  name: string;
  role: string;
  handle: string | null;
  stance: string | null;
};

export type LoreRecord = {
  ambiguous: boolean;
  canonicalName: string;
  entityType: EntityType;
  aliases: string[];
  tickers: string[];
  handles: string[];
  summary: string;
  currentState: StateEntry[];
  timeline: TimelineEntry[];
  team: TeamMember[];
  sentiment: EntitySentiment | null;
  officialStance: string | null;
  riskFlags: string[];
  confidence: number;
  citations: string[];
};

export type UsabilityCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether this record is worth sending. The bar is deliberately low — NurXai
 * decides what is safe, this only decides whether asking the operator again is
 * cheaper than sending something empty.
 */
export function isUsableRecord(record: LoreRecord): UsabilityCheck {
  if (!record.canonicalName.trim()) return { ok: false, reason: "the document never names the subject" };
  if (!record.summary.trim()) return { ok: false, reason: "the document has no summary to store" };
  if (record.summary.length < 40) {
    return { ok: false, reason: "the summary is too thin to be worth a record — ask for a longer answer" };
  }
  return { ok: true };
}

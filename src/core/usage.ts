// What a session spent and what fills its context. Only figures OpenCode reports are
// added up: step costs and tokens by model and agent, subagent session costs rolled up
// into the sessions that started them. The context breakdown estimates only the parts
// Sidecar can see and leaves the rest as one honest remainder.

import type { ContextBreakdown, CostBreakdown, CostRow, SubagentView, TokenUsage } from "../shared/model";
import { CHARS_PER_TOKEN } from "../shared/throughput";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Adds two costs; unknown (null) only when both are unknown. */
export function addCost(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

interface Bucket {
  steps: number;
  tokens: number;
  cost: number | null;
}

/** One session's steps, added up by model and by agent. */
export class CostLedger {
  private models = new Map<string, Bucket>();
  private agents = new Map<string, Bucket>();
  private stepCost: number | null = null;

  reset(): void {
    this.models.clear();
    this.agents.clear();
    this.stepCost = null;
  }

  add(step: {
    modelKey: string | null;
    agent?: string | null;
    cost?: number | null;
    tokens: TokenUsage;
  }): void {
    const cost = step.cost ?? null;
    const tokens = step.tokens.output + step.tokens.reasoning;
    const into = (map: Map<string, Bucket>, key: string) => {
      const b = map.get(key) ?? { steps: 0, tokens: 0, cost: null };
      b.steps++;
      b.tokens += tokens;
      b.cost = addCost(b.cost, cost);
      map.set(key, b);
    };
    into(this.models, step.modelKey ?? "");
    into(this.agents, step.agent ?? "");
    this.stepCost = addCost(this.stepCost, cost);
  }

  /** Sum of the step costs (null when no step reported one). */
  get cost(): number | null {
    return this.stepCost;
  }

  get empty(): boolean {
    return this.models.size === 0;
  }

  byModel(): Map<string, Bucket> {
    return this.models;
  }

  byAgent(): Map<string, Bucket> {
    return this.agents;
  }
}

/**
 * Each subagent's cost with its own subagents' included (`views` lists parents before
 * their subagents). A subagent with no subagents has no total: its own cost is the total.
 */
export function rollupCosts(views: readonly SubagentView[]): Map<string, number | null> {
  const total = new Map<string, number | null>(views.map((v) => [v.sessionID, v.cost]));
  const hasChildren = new Set<string>();
  // Children come after their parents, so walking backwards adds each finished subtree once.
  for (let i = views.length - 1; i >= 0; i--) {
    const v = views[i];
    if (!total.has(v.parentID)) continue;
    hasChildren.add(v.parentID);
    total.set(v.parentID, addCost(total.get(v.parentID) ?? null, total.get(v.sessionID) ?? null));
  }
  for (const id of [...total.keys()]) if (!hasChildren.has(id)) total.delete(id);
  return total;
}

/** Larger costs first, then more tokens. */
function byCost(a: CostRow, b: CostRow): number {
  return (b.cost ?? -1) - (a.cost ?? -1) || b.tokens - a.tokens;
}

/**
 * The usage menu's tables. `own` is the open session's ledger; `subagents` its subagents
 * with each one's ledger (empty for one known only from its session record, whose cost
 * is then counted under the model the record names).
 */
export function costBreakdown(
  own: CostLedger,
  sessionCost: number | null,
  subagents: ReadonlyArray<{ view: SubagentView; ledger: CostLedger; modelKey: string | null }>,
): CostBreakdown | null {
  if (own.empty && sessionCost === null && !subagents.length) return null;
  const models = new Map<string, Bucket>();
  const addModel = (key: string, b: Bucket) => {
    const m = models.get(key) ?? { steps: 0, tokens: 0, cost: null };
    m.steps += b.steps;
    m.tokens += b.tokens;
    m.cost = addCost(m.cost, b.cost);
    models.set(key, m);
  };
  for (const [key, b] of own.byModel()) addModel(key, b);
  for (const s of subagents) {
    if (!s.ledger.empty) for (const [key, b] of s.ledger.byModel()) addModel(key, b);
    else if (s.view.cost !== null) addModel(s.modelKey ?? "", { steps: 0, tokens: 0, cost: s.view.cost });
  }
  const byModel: CostRow[] = [...models].map(([key, b]) => ({
    key,
    label: key,
    steps: b.steps || null,
    tokens: b.tokens,
    cost: b.cost,
  }));
  byModel.sort(byCost);

  const byAgent: CostRow[] = [...own.byAgent()].map(([key, b]) => ({
    key,
    label: key,
    steps: b.steps,
    tokens: b.tokens,
    cost: b.cost,
  }));
  byAgent.sort(byCost);
  const totals = rollupCosts(subagents.map((s) => s.view));
  for (const s of subagents) {
    const t = s.ledger.empty ? null : [...s.ledger.byAgent().values()];
    const row: CostRow = {
      key: s.view.sessionID,
      label: s.view.agent ?? s.view.title,
      steps: t ? t.reduce((n, b) => n + b.steps, 0) : null,
      tokens: t ? t.reduce((n, b) => n + b.tokens, 0) : 0,
      cost: s.view.cost,
      depth: s.view.depth,
    };
    if (totals.has(s.view.sessionID)) row.total = totals.get(s.view.sessionID) ?? null;
    byAgent.push(row);
  }

  // OpenCode's session cost also covers title generation and compaction, which are no step.
  const session = sessionCost ?? own.cost;
  const stepCost = own.cost ?? 0;
  const other = session !== null && session - stepCost > 0.00005 ? session - stepCost : null;
  let total = session;
  for (const s of subagents)
    if (s.view.depth === 1) total = addCost(total, totals.get(s.view.sessionID) ?? s.view.cost);
  return { byModel, byAgent, session, total, other };
}

/** Tokens in a text, estimated. */
function estimate(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** Bytes of a base64 payload (a `data:` URI or bare base64). */
function base64Bytes(data: string): number {
  const b64 = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
  return Math.floor((b64.replace(/=+$/, "").length * 3) / 4);
}

/**
 * Splits the context OpenCode reported (`total`) across the messages it is built from
 * (`GET /api/session/{id}/context`). Message parts are estimated from their text; what
 * is left over is the system prompt, tool definitions and instructions, which OpenCode
 * adds to every request but does not list. A part with nothing in it is left out.
 */
export function contextBreakdown(
  messages: readonly unknown[],
  total: number | null,
  limit: number | null,
): ContextBreakdown {
  const chars = { prompts: 0, instructions: 0, replies: 0, tools: 0, summary: 0 };
  let fileBytes = 0;
  let images = 0;
  let count = 0;
  for (const raw of messages) {
    const m = rec(raw);
    if (!m) continue;
    count++;
    switch (m.type) {
      case "user":
        chars.prompts += str(m.text).length;
        for (const f of Array.isArray(m.files) ? m.files : []) {
          const file = rec(f);
          if (!file) continue;
          if (str(file.mime).startsWith("image/")) images++;
          else fileBytes += base64Bytes(str(file.data));
        }
        break;
      case "synthetic":
      case "skill":
        chars.prompts += str(m.text).length;
        break;
      case "system":
        // Instructions OpenCode posted into the conversation (an update, say).
        chars.instructions += str(m.text).length;
        break;
      case "shell": {
        chars.tools += str(m.command).length + str(rec(m.output)?.output).length;
        break;
      }
      case "compaction":
        chars.summary += str(m.text).length + str(m.summary).length;
        break;
      case "assistant":
        for (const p of Array.isArray(m.content) ? m.content : []) {
          const part = rec(p);
          if (!part) continue;
          if (part.type === "text" || part.type === "reasoning") chars.replies += str(part.text).length;
          else if (part.type === "tool") {
            const state = rec(part.state);
            chars.tools += str(part.name).length + JSON.stringify(state?.input ?? {}).length;
            for (const c of Array.isArray(state?.content) ? state.content : [])
              chars.tools += str(rec(c)?.text).length;
            chars.tools += str(state?.error && JSON.stringify(state.error)).length;
          }
        }
        break;
      default:
        break;
    }
  }
  const parts: ContextBreakdown["parts"] = [
    { key: "prompts", tokens: estimate(chars.prompts) },
    { key: "instructions", tokens: estimate(chars.instructions) },
    { key: "replies", tokens: estimate(chars.replies) },
    { key: "tools", tokens: estimate(chars.tools) },
    { key: "files", tokens: estimate(fileBytes) },
    { key: "summary", tokens: estimate(chars.summary) },
  ];
  const seen = parts.reduce((n, p) => n + p.tokens, 0);
  // An estimate above the reported total leaves no remainder rather than a negative one.
  if (total !== null && total > seen) parts.push({ key: "rest", tokens: total - seen });
  return { total, limit, parts: parts.filter((p) => p.tokens > 0), images, messages: count };
}

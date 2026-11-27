// Local task budget guard. It only measures what OpenCode actually reports
// (session cost from usage events, completed agent steps) and never invents
// provider quotas. A "task" is one OpenCode execution: from the prompt that
// starts the agent until it goes idle. It stops before the step that would cross the
// cost limit (judged by the task's average step cost), not after it.

import type { BudgetLevel, BudgetLimits, BudgetView } from "../shared/model";

export interface BudgetSettings {
  presets: Record<Exclude<BudgetLevel, "off">, BudgetLimits>;
  /** Fraction of the limit at which to warn, e.g. 0.8. */
  warnAt: number;
}

export const DEFAULT_BUDGETS: BudgetSettings["presets"] = {
  small: { maxCost: 0.1, maxSteps: 20 },
  medium: { maxCost: 0.3, maxSteps: 50 },
  large: { maxCost: 1.0, maxSteps: 120 },
  custom: { maxCost: 0.5, maxSteps: 80 },
};

export const BUDGET_LEVELS: BudgetLevel[] = ["off", "small", "medium", "large", "custom"];

/** `projected`: the limit is not reached yet, but one more step like the average would cross it. */
export type BudgetSignal =
  | { kind: "none" }
  | { kind: "warning" }
  | { kind: "exceeded"; metric: "cost" | "steps"; projected?: boolean };

export function nextLevel(level: BudgetLevel): BudgetLevel {
  if (level === "small") return "medium";
  if (level === "medium") return "large";
  return level;
}

export class BudgetTracker {
  level: BudgetLevel = "off";
  private costBase: number | null = null;
  private cost: number | null = null;
  private steps = 0;
  private allowance = 1;
  private carry = false;
  private warned = false;
  private exceeded = false;
  active = false;

  constructor(private settings: () => BudgetSettings) {}

  limits(): BudgetLimits {
    if (this.level === "off") return { maxCost: null, maxSteps: null };
    return this.settings().presets[this.level];
  }

  setLevel(level: BudgetLevel): void {
    this.level = level;
    // Re-evaluate against the new limits from scratch; an already-stopped task stays stopped.
    this.warned = false;
  }

  /** Called when an execution starts. `sessionCost` is the session's cost so far, if known. */
  startTask(sessionCost: number | null): void {
    this.active = true;
    if (this.carry) {
      // "Continue once" / "Increase budget": keep counting the same task.
      this.carry = false;
      this.exceeded = false;
      return;
    }
    this.costBase = sessionCost;
    this.cost = sessionCost;
    this.steps = 0;
    this.allowance = 1;
    this.warned = false;
    this.exceeded = false;
  }

  endTask(): void {
    this.active = false;
  }

  /** Forgets everything (new or switched session). */
  reset(): void {
    this.active = false;
    this.costBase = null;
    this.cost = null;
    this.steps = 0;
    this.allowance = 1;
    this.carry = false;
    this.warned = false;
    this.exceeded = false;
  }

  recordStep(): BudgetSignal {
    if (!this.active) return { kind: "none" };
    this.steps++;
    return this.evaluate();
  }

  /** Session cost reported by OpenCode (cumulative, USD). */
  recordCost(sessionCost: number): BudgetSignal {
    if (this.costBase === null) this.costBase = this.cost ?? 0;
    this.cost = sessionCost;
    return this.active ? this.evaluate() : { kind: "none" };
  }

  taskCost(): number | null {
    if (this.cost === null || this.costBase === null) return null;
    return Math.max(0, this.cost - this.costBase);
  }

  /** Grants one more budget-sized allowance for the current task (explicit user override). */
  continueOnce(): void {
    this.allowance += 1;
    this.carry = true;
    this.exceeded = false;
    this.warned = false;
  }

  /** The user raised the budget level; the current task continues under the new limits. */
  increaseTo(level: BudgetLevel): void {
    this.level = level;
    this.carry = true;
    this.exceeded = false;
    this.warned = false;
  }

  private fraction(): { value: number; metric: "cost" | "steps" } | null {
    const l = this.limits();
    let best: { value: number; metric: "cost" | "steps" } | null = null;
    const cost = this.taskCost();
    if (l.maxCost !== null && l.maxCost > 0 && cost !== null) {
      best = { value: cost / (l.maxCost * this.allowance), metric: "cost" };
    }
    if (l.maxSteps !== null && l.maxSteps > 0) {
      const v = this.steps / (l.maxSteps * this.allowance);
      if (!best || v > best.value) best = { value: v, metric: "steps" };
    }
    return best;
  }

  /**
   * The task's cost after one more step at its average step cost, as a share of the cost
   * limit; null without a cost limit, a reported cost or a finished step.
   */
  private projectedCost(): number | null {
    const l = this.limits();
    const cost = this.taskCost();
    if (l.maxCost === null || l.maxCost <= 0 || cost === null || cost <= 0 || this.steps === 0) return null;
    return (cost + cost / this.steps) / (l.maxCost * this.allowance);
  }

  evaluate(): BudgetSignal {
    if (this.level === "off" || this.exceeded) return { kind: "none" };
    const f = this.fraction();
    if (!f) return { kind: "none" };
    if (f.value >= 1) {
      this.exceeded = true;
      return { kind: "exceeded", metric: f.metric };
    }
    // Stop at the step boundary rather than let the next step go over the limit.
    const projected = this.projectedCost();
    if (projected !== null && projected > 1) {
      this.exceeded = true;
      return { kind: "exceeded", metric: "cost", projected: true };
    }
    if (f.value >= this.settings().warnAt && !this.warned) {
      this.warned = true;
      return { kind: "warning" };
    }
    return { kind: "none" };
  }

  isExceeded(): boolean {
    return this.exceeded;
  }

  view(): BudgetView {
    const f = this.level === "off" ? null : this.fraction();
    return {
      level: this.level,
      limits: this.limits(),
      taskCost: this.taskCost(),
      taskSteps: this.steps,
      active: this.active,
      state: this.exceeded ? "exceeded" : f && f.value >= this.settings().warnAt ? "warning" : "ok",
      allowance: this.allowance,
    };
  }
}

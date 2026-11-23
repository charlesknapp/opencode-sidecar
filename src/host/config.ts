import * as vscode from "vscode";
import { DEFAULT_BUDGETS, type BudgetSettings } from "../core/budget";
import type { BudgetLevel, BudgetLimits } from "../shared/model";

export interface SidebarConfig {
  executablePath: string;
  serverUrl: string;
  allowRemoteServer: boolean;
  defaultModel: string;
  defaultAgent: string;
  autoStart: boolean;
  showUsage: boolean;
  showStatusBarItem: boolean;
  budgetDefault: BudgetLevel;
  budget: BudgetSettings;
  contextWarnPercent: number;
  /** Pin the prompt of the turn being read while scrolling. */
  stickyPrompt: boolean;
  /** A playful word per run in the Working line, or plain "Working…". */
  statusWords: boolean;
  /** Minutes the provider keeps a prompt cached (estimate); 0 hides the clock. */
  cacheWarmMinutes: number;
  /** Every tool call on its own row, or runs folded into one line. */
  activity: "detailed" | "grouped";
}

export const CONFIG_SECTION = "opencodeSidecar";

const LEVELS: BudgetLevel[] = ["off", "small", "medium", "large", "custom"];

function limits(raw: unknown, fallback: BudgetLimits): BudgetLimits {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pos = (v: unknown, f: number | null) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : v === 0 ? null : f;
  return { maxCost: pos(r.maxCost, fallback.maxCost), maxSteps: pos(r.maxSteps, fallback.maxSteps) };
}

/** Task notification toggles (`opencodeSidecar.notifications.*`, all on by default). */
export function readNotificationSettings(): {
  taskComplete: boolean;
  needsInput: boolean;
  taskFailed: boolean;
  budgetStopped: boolean;
} {
  const c = vscode.workspace.getConfiguration("opencodeSidecar.notifications");
  return {
    taskComplete: c.get<boolean>("taskComplete", true),
    needsInput: c.get<boolean>("needsInput", true),
    taskFailed: c.get<boolean>("taskFailed", true),
    budgetStopped: c.get<boolean>("budgetStopped", true),
  };
}

export function readConfig(): SidebarConfig {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const level = c.get<string>("budget.default", "medium");
  const warn = c.get<number>("budget.warnPercent", 80);
  const ctx = c.get<number>("budget.contextWarnPercent", 80);
  return {
    executablePath: c.get<string>("executablePath", ""),
    serverUrl: c.get<string>("serverUrl", ""),
    allowRemoteServer: c.get<boolean>("allowRemoteServer", false),
    defaultModel: c.get<string>("defaultModel", ""),
    defaultAgent: c.get<string>("defaultAgent", ""),
    autoStart: c.get<boolean>("autoStart", false),
    showUsage: c.get<boolean>("showUsage", true),
    showStatusBarItem: c.get<boolean>("showStatusBarItem", true),
    budgetDefault: (LEVELS as string[]).includes(level) ? (level as BudgetLevel) : "medium",
    budget: {
      presets: {
        small: limits(c.get("budget.small"), DEFAULT_BUDGETS.small),
        medium: limits(c.get("budget.medium"), DEFAULT_BUDGETS.medium),
        large: limits(c.get("budget.large"), DEFAULT_BUDGETS.large),
        custom: limits(c.get("budget.custom"), DEFAULT_BUDGETS.custom),
      },
      warnAt: Math.min(0.99, Math.max(0.1, (Number.isFinite(warn) ? warn : 80) / 100)),
    },
    contextWarnPercent: Number.isFinite(ctx) ? Math.min(100, Math.max(0, ctx)) : 80,
    stickyPrompt: c.get<boolean>("stickyPrompt", true),
    statusWords: c.get<boolean>("statusWords", true),
    cacheWarmMinutes: (() => {
      const v = c.get<number>("cacheWarmMinutes", 5);
      return Number.isFinite(v) ? Math.min(120, Math.max(0, v)) : 5;
    })(),
    activity: c.get<string>("activity", "detailed") === "grouped" ? "grouped" : "detailed",
  };
}

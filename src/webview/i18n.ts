// Minimal UI strings for the chat controls. English is the default; Arabic is
// used when VS Code's display language is Arabic. Untranslated keys fall back
// to English.

const EN = {
  copy: "Copy",
  copied: "✓ Copied",
  copyFailed: "Copy failed",
  copyMessage: "Copy message",
  copyCode: "Copy code",
  steer: "Steer",
  queue: "Queue",
  queued: "Queued",
  steering: "Steering",
  edit: "Edit",
  remove: "Remove",
  budget: "Budget",
  continueOnce: "Continue once",
  increaseBudget: "Increase budget",
  newSession: "Start new session",
  submit: "Submit",
  agentChanges: "Agent changes",
  reviewAll: "Review all",
  workspaceChanges: "Workspace changes",
  agentDiffUnavailable: "Agent-only diff unavailable",
  changeModel: "Change model",
  chooseModel: "Choose another model",
  retry: "Retry",
  subagents: "Subagents",
  subagent: "Subagent",
  openSubagent: "Open",
  stopSubagent: "Stop",
  backToChat: "Back to chat",
  subagentStarting: "Starting…",
  subagentWriting: "Writing…",
  subagentThinking: "Thinking…",
  subagentLoading: "Loading the subagent's conversation…",
  subagentEmpty: "This subagent has no messages yet.",
  subagentReadOnly: "Viewing a subagent. Go back to the chat to send a message.",
  fromSubagent: "From subagent",
  statusRunning: "Running",
  statusWaiting: "Waiting for you",
  statusCompleted: "Completed",
  statusStopped: "Stopped",
  statusFailed: "Failed",
  subagentFinished: "Finished",
  waitingPermission: "Waiting for your permission: see the request below",
  waitingAnswer: "Waiting for your answer: see the question below",
  reportFrom: "Report from",
};

const AR: Partial<typeof EN> = {
  copy: "نسخ",
  copied: "✓ تم النسخ",
  copyFailed: "تعذّر النسخ",
  copyMessage: "نسخ الرسالة",
  copyCode: "نسخ الكود",
  steer: "توجيه",
  queue: "انتظار",
  queued: "في الانتظار",
  steering: "توجيه",
  edit: "تعديل",
  remove: "حذف",
  budget: "الميزانية",
  continueOnce: "متابعة لمرة واحدة",
  increaseBudget: "رفع الميزانية",
  newSession: "بدء جلسة جديدة",
  submit: "إرسال",
  changeModel: "تغيير النموذج",
  retry: "إعادة المحاولة",
};

export type StringKey = keyof typeof EN;

export function translate(locale: "en" | "ar", key: StringKey): string {
  return (locale === "ar" ? AR[key] : undefined) ?? EN[key];
}

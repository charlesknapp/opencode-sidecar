// The model the live tests that send a prompt use. The default is OpenCode's free model;
// OCS_LIVE_MODEL picks another one the service offers (for example a connected provider's
// model when the free daily limit is reached), as ACCEPT_MODEL does for the acceptance runs.
//
//   $env:OCS_LIVE_MODEL="deepseek/deepseek-flash"; npm run test:live

/** "provider/model". */
export const LIVE_MODEL_KEY = process.env.OCS_LIVE_MODEL?.trim() || "opencode/big-pickle";

const slash = LIVE_MODEL_KEY.indexOf("/");
if (slash <= 0 || slash === LIVE_MODEL_KEY.length - 1)
  throw new Error(`OCS_LIVE_MODEL must be "provider/model", not "${LIVE_MODEL_KEY}"`);

export const LIVE_MODEL = { providerID: LIVE_MODEL_KEY.slice(0, slash), id: LIVE_MODEL_KEY.slice(slash + 1) };

/** OpenCode's own free models report a cost of 0 per step. */
export const LIVE_MODEL_FREE =
  LIVE_MODEL.providerID === "opencode" && /big-pickle|-free$/.test(LIVE_MODEL.id);

/** The skip reason when the service does not offer the model. */
export const NOT_OFFERED = `${LIVE_MODEL_KEY} is not offered`;

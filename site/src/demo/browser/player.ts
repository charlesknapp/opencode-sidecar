import { createDemo } from "@/demo/engine"

type VsCodeApi = {
  postMessage: (message: unknown) => void
  getState: () => undefined
  setState: () => void
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi
  }
}

const demo = createDemo({
  post: (message) => window.postMessage(message, window.location.origin),
  after: (ms, run) => {
    const id = window.setTimeout(run, ms)
    return () => window.clearTimeout(id)
  },
  now: () => Date.now(),
})

window.acquireVsCodeApi = () => ({
  postMessage: (message) => window.setTimeout(() => demo.handle(message), 0),
  getState: () => undefined,
  setState: () => undefined,
})

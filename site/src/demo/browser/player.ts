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

const frameOnScreen = { visible: false }
new IntersectionObserver(([entry]) => {
  frameOnScreen.visible = entry?.isIntersecting ?? false
}).observe(document.documentElement)

const focusElement = HTMLElement.prototype.focus
HTMLElement.prototype.focus = function focusOnlyWhileInUse(
  options?: FocusOptions
) {
  if (!document.hasFocus() || !frameOnScreen.visible) return
  focusElement.call(this, options)
}

window.acquireVsCodeApi = () => ({
  postMessage: (message) => window.setTimeout(() => demo.handle(message), 0),
  getState: () => undefined,
  setState: () => undefined,
})

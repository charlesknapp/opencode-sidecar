// Must be imported before Prism: in a browser, Prism highlights every
// `code[class*="language-"]` element on load and writes the result with innerHTML.
// Manual mode turns that off; Sidecar only uses Prism's tokenizer (see highlight.ts).
(window as unknown as { Prism?: { manual: boolean; disableWorkerMessageHandler: boolean } }).Prism = {
  manual: true,
  disableWorkerMessageHandler: true,
};

export {};

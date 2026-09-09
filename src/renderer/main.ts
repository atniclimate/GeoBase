import "./styles/app.css";

globalThis.CESIUM_BASE_URL = new URL("./cesium/", document.baseURI).href;

async function startSelectedRenderer(): Promise<void> {
  const testScene = new URLSearchParams(window.location.search).get("testScene");
  if (testScene === null) {
    document.body.dataset.rendererEntry = "standard";
    const { startApplication } = await import("./application");
    startApplication();
    return;
  }
  if (testScene !== "rstep-demo-spike") {
    throw new Error(`Unsupported renderer test scene: ${testScene || "[empty]"}`);
  }

  document.body.dataset.rendererEntry = testScene;
  const moduleUrl = new URL("./rstep-demo-spike/entry.js", document.baseURI).href;
  const module = (await import(/* @vite-ignore */ moduleUrl)) as {
    startRstepDemoSpike?: () => Promise<void> | void;
  };
  if (typeof module.startRstepDemoSpike !== "function") {
    throw new TypeError("The RSTEP compatibility spike renderer has no supported entry function.");
  }
  await module.startRstepDemoSpike();
}

void startSelectedRenderer().catch((error: unknown) => {
  document.body.dataset.appReady = "error";
  document.body.dataset.workflowState = "error";
  for (const layerState of document.querySelectorAll<HTMLElement>(
    ".rstep-layer-control [data-state='loading']",
  )) {
    layerState.dataset.state = "deferred";
    layerState.textContent = "deferred";
  }
  const status = document.querySelector<HTMLElement>("#workflow-status");
  const text = document.querySelector<HTMLElement>("#workflow-status-text");
  if (status !== null) status.dataset.state = "error";
  if (text !== null) {
    text.textContent = `Application failed to start: ${error instanceof Error ? error.message : "unknown error"}`;
  }
  console.error(error);
});

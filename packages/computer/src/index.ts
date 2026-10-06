export {
  CHROME_DEBUG_PORT,
  CHROME_PROFILE,
  COMPUTER_DOCKERFILE,
  DockerComputer,
  type DockerComputerEnvironmentOptions,
  type DockerComputerOpenOptions,
  installChrome,
  installDesktopShell,
  openChromeCommand,
  startDesktopShell,
} from "./provider.js";
export { COMPUTER_INSTRUCTIONS } from "./instructions.js";
export {
  BROWSER_OVERRIDES,
  type BrowserDecision,
  type BrowserOverride,
  CONNECTOR_HOSTS,
  decideBrowserUse,
  serviceForUrl,
} from "./policy.js";
export { closeTabsTool, openBrowserTool, type OpenBrowserOptions } from "./tools.js";
export { computerTool, type ComputerToolOptions } from "./computer-tool.js";
export { prepareComputer, startComputer } from "./lifecycle.js";
export { fillOnComputer, FILL_SCRIPT, type FillField, type FillRequest, type FillResult } from "./fill.js";

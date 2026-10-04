export {
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

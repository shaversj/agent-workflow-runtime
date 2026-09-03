import { githubTools } from "./github/tools.js";
import { readinessTools } from "./readiness/tools.js";

export const defaultPluginTools = [...readinessTools, ...githubTools];

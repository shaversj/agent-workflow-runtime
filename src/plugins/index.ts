import { githubTools } from "./github/tools.js";
import { readinessTools } from "./readiness/tools.js";
import { codingPlugin } from "./coding/tools.js";

export const defaultPluginTools = [...readinessTools, ...githubTools, ...codingPlugin.tools];

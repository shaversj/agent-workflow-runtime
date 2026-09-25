import { githubTools } from "./github/tools.js";
import { readinessTools } from "./readiness/tools.js";
import { codingPlugin } from "./coding/tools.js";
import { rulesTools } from "./rules/tools.js";
import { rulesBenchmarkTools } from "./rules-benchmark/tools.js";

export const defaultPluginTools = [
  ...readinessTools,
  ...githubTools,
  ...rulesTools,
  ...rulesBenchmarkTools,
  ...codingPlugin.tools
];

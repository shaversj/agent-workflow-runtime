import {
  requestBoundedJson as requestJson,
  type BoundedHttpLimits,
  type BoundedJsonRequestOptions,
  type BoundedJsonResponse
} from "../../harness/http.js";

export type GitHubHttpLimits = BoundedHttpLimits;
export type GitHubJsonResponse = BoundedJsonResponse;

export async function requestBoundedJson(
  rawUrl: string,
  options: BoundedJsonRequestOptions
): Promise<GitHubJsonResponse> {
  try {
    return await requestJson(rawUrl, options);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("http_")) {
      throw new Error(`github_${error.message.slice("http_".length)}`);
    }
    throw error;
  }
}

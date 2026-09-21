import { isIP } from "node:net";
import path from "node:path";

import { Value } from "typebox/value";

import { resolveGitRoot } from "./git.js";
import { TargetProvenanceSchema, TargetRefSchema } from "./types.js";
import type { TargetProvenance, TargetRef, TargetTransportPolicy } from "./types.js";

const DEFAULT_DISCORD_HOST = "github.com";
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const URL_LIKE_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const SCP_LIKE_PATTERN = /^[^/@\s]+@[^/:\s]+:.+$/;

export const CLI_TARGET_PROVENANCE = Object.freeze({ source: "cli" } as const);
export const OPERATOR_DEFAULT_TARGET_PROVENANCE = Object.freeze({
  source: "operator-default",
  localPathCapability: "operator-default"
} as const);

export function discordExplicitTargetProvenance(
  exactHost: string = DEFAULT_DISCORD_HOST
): TargetProvenance {
  return Object.freeze({ source: "discord-explicit", exactHost: normalizeExactHost(exactHost) });
}

export function parseTargetRef(
  input: string,
  ref?: string,
  provenance: TargetProvenance = CLI_TARGET_PROVENANCE
): TargetRef {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Repository target is required.");
  const validatedProvenance = validateTargetProvenance(provenance);
  const validatedRef = validateRef(ref);

  if (isGitUrl(trimmed)) {
    const url = normalizeHttpsTarget(trimmed, validatedProvenance);
    return validateTargetRef({
      kind: "git-url",
      url,
      ...(validatedRef ? { ref: validatedRef } : {}),
      provenance: validatedProvenance,
      policy: resolveTargetPolicy({ kind: "git-url", url }, validatedProvenance)
    });
  }

  validateLocalPath(trimmed, validatedProvenance);
  const targetPath = path.resolve(trimmed);
  return validateTargetRef({
    kind: "local-git",
    path: targetPath,
    ...(validatedRef ? { ref: validatedRef } : {}),
    provenance: validatedProvenance,
    policy: resolveTargetPolicy({ kind: "local-git", path: targetPath }, validatedProvenance)
  });
}

export function normalizedTargetRef(target: TargetRef): TargetRef {
  const validated = validateTargetRef(target);
  if (validated.kind === "git-url") return validated;
  return validateTargetRef({ ...validated, path: resolveGitRoot(validated.path) });
}

export function resolveTargetPolicy(
  target:
    | Pick<Extract<TargetRef, { kind: "local-git" }>, "kind" | "path">
    | Pick<Extract<TargetRef, { kind: "git-url" }>, "kind" | "url">,
  provenance: TargetProvenance
): TargetTransportPolicy {
  const validatedProvenance = validateTargetProvenance(provenance);
  const localPathCapability = capabilityFor(validatedProvenance);

  if (target.kind === "local-git") {
    validateLocalPath(target.path, validatedProvenance);
    return {
      protocol: "local",
      exactHost: null,
      allowRedirects: false,
      allowSecondaryFetches: false,
      localPathCapability
    };
  }

  const parsed = new URL(normalizeHttpsTarget(target.url, validatedProvenance));
  return {
    protocol: "https",
    exactHost: parsed.hostname,
    allowRedirects: false,
    allowSecondaryFetches: false,
    localPathCapability
  };
}

export function validateTargetRef(value: unknown): TargetRef {
  if (!Value.Check(TargetRefSchema, value)) throw new Error("Invalid repository target contract.");
  const target = value;
  const provenance = validateTargetProvenance(target.provenance);
  validateRef(target.ref);

  if (target.kind === "local-git") {
    validateLocalPath(target.path, provenance);
    if (target.path !== path.resolve(target.path)) {
      throw new Error("Local repository targets must be absolute.");
    }
  } else if (target.url !== normalizeHttpsTarget(target.url, provenance)) {
    throw new Error("Repository URL is not canonical.");
  }

  const expected = resolveTargetPolicy(target, provenance);
  if (!samePolicy(target.policy, expected)) {
    throw new Error("Repository target policy does not match its provenance.");
  }
  return target;
}

export function isGitUrl(value: string): boolean {
  const trimmed = value.trim();
  return URL_LIKE_PATTERN.test(trimmed) || SCP_LIKE_PATTERN.test(trimmed);
}

function validateTargetProvenance(provenance: unknown): TargetProvenance {
  if (!Value.Check(TargetProvenanceSchema, provenance)) {
    throw new Error("Invalid repository target provenance.");
  }
  if (
    provenance.source === "discord-explicit" &&
    provenance.exactHost !== normalizeExactHost(provenance.exactHost)
  ) {
    throw new Error("Discord repository host is not canonical.");
  }
  return provenance;
}

function normalizeHttpsTarget(input: string, provenance: TargetProvenance): string {
  if (!/^https:\/\/[^/]/i.test(input) || hasControlCharacter(input) || /\s|\\/.test(input)) {
    throw new Error("Repository target must use an unambiguous HTTPS URL.");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Repository target must use a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:" || parsed.origin === "null") {
    throw new Error("Repository target must use HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Repository target credentials are not allowed.");
  }
  if (parsed.port) throw new Error("Repository target ports are not allowed.");

  const hostname = parsed.hostname.toLowerCase();
  if (!HOSTNAME_PATTERN.test(hostname)) {
    throw new Error("Repository target host is invalid.");
  }

  if (provenance.source === "discord-explicit") {
    if (isIP(hostname) !== 0) throw new Error("Discord repository targets cannot use IP hosts.");
    if (hostname !== provenance.exactHost) {
      throw new Error("Discord repository target host is not approved.");
    }
    if (parsed.search || parsed.hash) {
      throw new Error("Discord repository targets cannot include a query or fragment.");
    }
  }

  parsed.hostname = hostname;
  return parsed.href;
}

function validateLocalPath(input: string, provenance: TargetProvenance): void {
  if (
    !input ||
    hasControlCharacter(input) ||
    input.startsWith("-") ||
    input.startsWith("//") ||
    input.startsWith("\\\\") ||
    URL_LIKE_PATTERN.test(input) ||
    SCP_LIKE_PATTERN.test(input)
  ) {
    throw new Error("Repository target is not an unambiguous local path.");
  }
  if (capabilityFor(provenance) === "none") {
    throw new Error("Repository target provenance does not allow local paths.");
  }
}

function validateRef(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  if (
    !ref ||
    ref.length > 1024 ||
    ref !== ref.trim() ||
    ref.startsWith("-") ||
    hasControlCharacter(ref)
  ) {
    throw new Error("Repository ref is invalid.");
  }
  return ref;
}

function capabilityFor(provenance: TargetProvenance): TargetTransportPolicy["localPathCapability"] {
  if (provenance.source === "cli") return "direct-cli";
  if (provenance.source === "operator-default") return "operator-default";
  return "none";
}

function normalizeExactHost(host: string): string {
  const normalized = host.toLowerCase();
  if (host !== host.trim() || normalized.endsWith(".") || !HOSTNAME_PATTERN.test(normalized)) {
    throw new Error("Discord repository host is invalid.");
  }
  if (isIP(normalized) !== 0) throw new Error("Discord repository host cannot be an IP address.");
  return normalized;
}

function samePolicy(left: TargetTransportPolicy, right: TargetTransportPolicy): boolean {
  return (
    left.protocol === right.protocol &&
    left.exactHost === right.exactHost &&
    left.allowRedirects === right.allowRedirects &&
    left.allowSecondaryFetches === right.allowSecondaryFetches &&
    left.localPathCapability === right.localPathCapability
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

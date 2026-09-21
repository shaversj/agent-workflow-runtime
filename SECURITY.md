# Security Policy

## Reporting A Vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a public issue or
pull request for a suspected vulnerability, and do not include credentials, tokens, private source,
or raw exploit output in public artifacts.

Include the affected revision, a minimal impact description, safe reproduction steps, and any
known mitigation. Redact secrets and private repository content. The maintainer will acknowledge a
complete report and coordinate validation, remediation, and disclosure through the private advisory.

## Supported Version

Security fixes target the current `main` branch. This source project does not publish an npm package
or support older release lines.

## Security Boundary

Read-only repository inspection is the default. Coding and publication are separate, disabled by
default, and require explicit operator policy and human approval. Containers reduce accidental
host access but are not a hostile multi-tenant security boundary.

interface ParsedInspectionRunRef {
  targetKey?: string;
  runId: number;
}

export function parseInspectionRunRef(runRef: string): ParsedInspectionRunRef | undefined {
  const trimmed = cleanInspectionRunRef(runRef);
  const targetQualified = /^([A-Za-z0-9._-]+):([0-9]+)$/.exec(trimmed);
  if (targetQualified) {
    return { targetKey: targetQualified[1], runId: Number.parseInt(targetQualified[2]!, 10) };
  }
  if (/^[0-9]+$/.test(trimmed)) return { runId: Number.parseInt(trimmed, 10) };
  return undefined;
}

function cleanInspectionRunRef(runRef: string): string {
  return runRef.trim().replace(/[),.;]+$/, "");
}

export function isTargetQualifiedInspectionRunRef(runRef: string): boolean {
  return Boolean(parseInspectionRunRef(runRef)?.targetKey);
}

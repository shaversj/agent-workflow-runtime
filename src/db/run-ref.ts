interface ParsedInspectionRunRef {
  runId: number;
}

export function parseInspectionRunRef(runRef: string): ParsedInspectionRunRef | undefined {
  const trimmed = runRef.trim();
  const runId = Number(trimmed);
  if (/^[1-9][0-9]*$/.test(trimmed) && Number.isSafeInteger(runId)) return { runId };
  return undefined;
}

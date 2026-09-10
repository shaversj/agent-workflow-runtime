import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FileText,
  History,
  RefreshCw,
  Search
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";

import type {
  CaptureEnvelope,
  HistoryActivityItem,
  HistoryDetailResult,
  HistoryListResult
} from "../../../harness/history-schemas.js";
import { validateInspectorResponse } from "../contracts.js";
import type { InspectorListOptions, InspectorReport, InspectorRequest } from "../contracts.js";
import "./styles.css";

const time = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit"
      })
    : "Not finished";
const shortTarget = (value: string | null) =>
  value ? value.replace(/^https?:\/\//, "").replace(/\.git$/, "") : "No target";
const count = (value: number) => value.toLocaleString();

function Badge({ children, kind = "neutral" }: { children: ReactNode; kind?: string }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}
function Capture({
  value,
  missing = "Not captured"
}: {
  value: CaptureEnvelope | null;
  missing?: string;
}) {
  if (!value) return <p className="muted">{missing}</p>;
  const labels = [
    value.redacted && "Redacted",
    value.truncated && "Truncated",
    value.omitted && "Omitted",
    value.incomplete && "Incomplete"
  ].filter(Boolean);
  return (
    <div className="capture">
      {labels.length > 0 && (
        <p className="capture-flags">
          {labels.join(" / ")}
          {value.reasons.length > 0 && `: ${value.reasons.join(", ")}`}
        </p>
      )}
      <pre>{value.text || (value.omitted ? "Content omitted" : "Empty capture")}</pre>
    </div>
  );
}
function Pager({
  previous,
  next,
  onPrevious,
  onNext,
  label
}: {
  previous: boolean;
  next: boolean;
  onPrevious: () => void;
  onNext: () => void;
  label: string;
}) {
  return (
    <div className="pager">
      <span>{label}</span>
      <div>
        <button
          title="Previous page"
          aria-label="Previous page"
          disabled={!previous}
          onClick={onPrevious}
        >
          <ChevronLeft size={16} />
        </button>
        <button title="Next page" aria-label="Next page" disabled={!next} onClick={onNext}>
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
function Activity({
  item,
  expanded,
  toggle,
  openReport
}: {
  item: HistoryActivityItem;
  expanded: boolean;
  toggle: () => void;
  openReport: (id: number) => void;
}) {
  const r = item.record;
  let title: string;
  switch (item.kind) {
    case "message":
      title = `${item.record.role === "user" ? "Request" : "Response"} #${r.id}`;
      break;
    case "run":
      title = `${item.record.kind} / run ${r.id}`;
      break;
    case "tool":
      title = `${item.record.name} / ${item.record.kind}`;
      break;
    case "model":
      title = `${item.record.provider} / ${item.record.model}`;
      break;
    case "artifact":
      title = item.record.title ?? item.record.path.split("/").at(-1) ?? "Report";
      break;
    case "delivery":
      title = `Delivery / message ${item.record.messageId}, part ${item.record.part}, attempt ${item.record.attempt}`;
      break;
  }
  return (
    <details
      className="activity-row"
      open={expanded}
      onToggle={(event) => {
        if (event.currentTarget.open !== expanded) toggle();
      }}
    >
      <summary>
        <span className="activity-kind">{item.kind}</span>
        <strong>{title}</strong>
        <span className="activity-time">{time(item.at)}</span>
      </summary>
      <div className="activity-body">
        {item.kind === "message" && <Capture value={item.record.content} />}
        {item.kind === "tool" && (
          <>
            <dl>
              <dt>Run</dt>
              <dd>{item.record.runId}</dd>
              <dt>Kind</dt>
              <dd>{item.record.kind}</dd>
              <dt>Status</dt>
              <dd>{item.record.status}</dd>
              <dt>Finished</dt>
              <dd>{time(item.record.finishedAt)}</dd>
            </dl>
            <h4>Input</h4>
            <Capture value={item.record.input} />
            <h4>Result</h4>
            <Capture value={item.record.result} missing="No result captured yet" />
            <h4>Failure</h4>
            <Capture value={item.record.error} missing="No failure recorded" />
          </>
        )}
        {item.kind === "run" && (
          <>
            <dl>
              <dt>Parent run</dt>
              <dd>{item.record.parentRunId ?? "Root"}</dd>
              <dt>Target</dt>
              <dd>{item.record.target ?? "None"}</dd>
              <dt>Ref</dt>
              <dd>{item.record.ref ?? "Not captured"}</dd>
              <dt>Commit</dt>
              <dd>{item.record.commitSha ?? "Not captured"}</dd>
              <dt>Status</dt>
              <dd>{item.record.status}</dd>
              <dt>Started</dt>
              <dd>{time(item.record.startedAt)}</dd>
              <dt>Finished</dt>
              <dd>{time(item.record.finishedAt)}</dd>
            </dl>
            <Capture value={item.record.error} missing="No failure recorded" />
          </>
        )}
        {item.kind === "model" && (
          <>
            <dl>
              <dt>Run</dt>
              <dd>{item.record.runId}</dd>
              <dt>Status</dt>
              <dd>{item.record.status}</dd>
              <dt>Usage</dt>
              <dd>
                {item.record.usageState === "known"
                  ? `${count(item.record.totalTokens ?? 0)} tokens (${count(item.record.inputTokens ?? 0)} input, ${count(item.record.outputTokens ?? 0)} output)`
                  : "Unknown"}
              </dd>
              <dt>Finished</dt>
              <dd>{time(item.record.finishedAt)}</dd>
            </dl>
            <Capture value={item.record.error} missing="No failure recorded" />
          </>
        )}
        {item.kind === "delivery" && (
          <>
            <dl>
              <dt>Delivery</dt>
              <dd>{item.record.status}</dd>
              <dt>Finished</dt>
              <dd>{time(item.record.finishedAt)}</dd>
            </dl>
            <Capture value={item.record.error} missing="No delivery failure recorded" />
          </>
        )}
        {item.kind === "artifact" && (
          <>
            <p className="path">{item.record.path}</p>
            <p>{item.record.availability}</p>
            {item.record.type === "markdown" && (
              <button
                className="command"
                onClick={() => {
                  openReport(item.record.id);
                }}
              >
                <FileText size={16} />
                Read report
              </button>
            )}
          </>
        )}
      </div>
    </details>
  );
}

export default function App() {
  const [filters, setFilters] = useState<InspectorListOptions>({});
  const [target, setTarget] = useState("");
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const [activityPages, setActivityPages] = useState<(string | undefined)[]>([undefined]);
  const [list, setList] = useState<HistoryListResult>();
  const [detail, setDetail] = useState<HistoryDetailResult>();
  const [selected, setSelected] = useState<string>();
  const [selectedTitle, setSelectedTitle] = useState("Saved request");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reportId, setReportId] = useState<number>();
  const [report, setReport] = useState<InspectorReport>();
  const [error, setError] = useState<string>();
  const [updated, setUpdated] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const polling = useRef(Promise.resolve());
  const cursor = pages.at(-1);
  const activityCursor = activityPages.at(-1);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function query(request: InspectorRequest) {
      const result = await fetch("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(5000)
      });
      if (!result.ok) throw new Error("History request failed");
      const response = validateInspectorResponse(await result.json());
      if (!response.ok) throw new Error(response.error);
      if (response.method !== request.method) throw new Error("Unexpected history response");
      return response;
    }
    async function poll() {
      if (cancelled) return;
      setPending(true);
      try {
        const rows = await query({
          method: "list",
          options: { ...filters, limit: 20, ...(cursor ? { cursor } : {}) }
        });
        if (cancelled) return;
        if (rows.method === "list") setList(rows.data);
        if (selected) {
          const data = await query({
            method: "show",
            id: selected,
            options: { limit: 50, ...(activityCursor ? { cursor: activityCursor } : {}) }
          });
          if (cancelled) return;
          if (data.method === "show") setDetail(data.data);
        }
        if (selected && reportId) {
          const data = await query({
            method: "report",
            interactionId: selected,
            artifactId: reportId
          });
          if (cancelled) return;
          if (data.method === "report") setReport(data.data);
        }
        setUpdated(new Date().toISOString());
        setError(undefined);
      } catch {
        if (!cancelled)
          setError(
            "History could not be refreshed. Check the local store and filters, then retry."
          );
      } finally {
        if (!cancelled) {
          setPending(false);
          timer = setTimeout(
            () => {
              polling.current = polling.current.then(poll);
            },
            document.hidden ? 10000 : 3000
          );
        }
      }
    }
    // A cancelled effect must finish its request before the next generation starts.
    const next = polling.current.then(poll);
    polling.current = next;
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filters, cursor, selected, activityCursor, reportId, refresh]);

  function changeFilters(next: InspectorListOptions) {
    setFilters(next);
    setPages([undefined]);
    setList(undefined);
    setUpdated(undefined);
  }
  function choose(id: string) {
    setSelected(id);
    setSelectedTitle(
      list?.interactions.find((row) => row.id === id)?.requestPreview || "Saved request"
    );
    setDetail(undefined);
    setActivityPages([undefined]);
    setExpanded(new Set());
    setReportId(undefined);
    setReport(undefined);
  }
  function openReport(id: number) {
    setReportId(id);
    setReport(undefined);
  }
  const current = detail?.found ? detail : undefined;
  const interaction = current?.interaction;
  const items = current?.activity.items ?? [];
  const messages = items.filter((item) => item.kind === "message");
  const artifacts = items.filter((item) => item.kind === "artifact");
  const tools = items.filter((item) => item.kind === "tool");
  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <div className="app" data-selected={Boolean(selected)} data-report={Boolean(reportId)}>
      <header className="app-header">
        <div className="brand">
          <History size={22} />
          <strong>Agent Ops Kit</strong>
          <span>History</span>
        </div>
        <div className="freshness">
          <span className={error ? "warning-text" : "muted"}>
            {error ? "Stale / unavailable" : updated ? `Updated ${time(updated)}` : "Connecting"}
          </span>
          <button
            title="Refresh history"
            aria-label="Refresh history"
            disabled={pending}
            onClick={() => {
              setRefresh((value) => value + 1);
            }}
          >
            <RefreshCw size={17} />
          </button>
        </div>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          {error}
          {list && " Previously loaded records may be stale."}
        </div>
      )}
      <div className="workspace">
        <aside className="sidebar" aria-label="Interactions" hidden={Boolean(reportId)}>
          <div className="sidebar-heading">
            <h1>Interactions</h1>
            <Badge>Local</Badge>
          </div>
          <form
            className="filters"
            onSubmit={(event) => {
              event.preventDefault();
              changeFilters({ ...filters, target: target.trim() || undefined });
            }}
          >
            <div className="target-filter">
              <input
                aria-label="Target"
                placeholder="Exact repository target"
                value={target}
                onChange={(event) => {
                  setTarget(event.target.value);
                }}
              />
              <button aria-label="Filter target" title="Filter target">
                <Search size={16} />
              </button>
            </div>
            <div className="filter-row">
              <label>
                Source
                <select
                  value={filters.source ?? ""}
                  onChange={(event) => {
                    changeFilters({
                      ...filters,
                      source: (event.target.value as InspectorListOptions["source"]) || undefined
                    });
                  }}
                >
                  <option value="">All sources</option>
                  <option value="cli">CLI</option>
                  <option value="discord">Discord</option>
                </select>
              </label>
              <label>
                Outcome
                <select
                  value={filters.outcome ?? ""}
                  onChange={(event) => {
                    changeFilters({
                      ...filters,
                      outcome: (event.target.value as InspectorListOptions["outcome"]) || undefined
                    });
                  }}
                >
                  <option value="">All outcomes</option>
                  {["running", "completed", "failed", "skipped", "cancelled", "interrupted"].map(
                    (value) => (
                      <option key={value}>{value}</option>
                    )
                  )}
                </select>
              </label>
            </div>
            <div className="filter-row">
              <label>
                From
                <input
                  aria-label="From date"
                  type="date"
                  onChange={(event) => {
                    changeFilters({
                      ...filters,
                      since: event.target.value
                        ? new Date(`${event.target.value}T00:00:00`).toISOString()
                        : undefined
                    });
                  }}
                />
              </label>
              <label>
                Through
                <input
                  aria-label="Through date"
                  type="date"
                  onChange={(event) => {
                    changeFilters({
                      ...filters,
                      until: event.target.value
                        ? new Date(`${event.target.value}T23:59:59.999`).toISOString()
                        : undefined
                    });
                  }}
                />
              </label>
            </div>
          </form>
          <div className="interaction-list">
            {!list && (
              <p className="empty">{error ? "History unavailable" : "Loading interactions..."}</p>
            )}
            {list?.interactions.length === 0 && (
              <p className="empty">
                {list.store === "absent"
                  ? "No history store yet"
                  : hasFilters
                    ? "No matching interactions"
                    : "No interactions recorded"}
              </p>
            )}
            {list?.interactions.map((row) => (
              <button
                key={row.id}
                className={`interaction ${selected === row.id ? "selected" : ""}`}
                onClick={() => {
                  choose(row.id);
                }}
                aria-pressed={selected === row.id}
              >
                <span className="interaction-meta">
                  <span>{row.source.toUpperCase()}</span>
                  <time>{time(row.startedAt)}</time>
                </span>
                <strong>{row.requestPreview || "Request not captured"}</strong>
                <span className="target">{shortTarget(row.target)}</span>
                <span className="interaction-status">
                  <Badge kind={row.status}>{row.status}</Badge>
                  {row.incomplete && <Badge kind="warning">Incomplete</Badge>}
                  {row.requestPreviewLimited && <span className="muted">Limited preview</span>}
                </span>
              </button>
            ))}
          </div>
          <Pager
            label={`Page ${pages.length}`}
            previous={pages.length > 1}
            next={Boolean(list?.nextCursor)}
            onPrevious={() => {
              setPages((value) => value.slice(0, -1));
              setList(undefined);
            }}
            onNext={() => {
              if (list?.nextCursor) {
                setPages((value) => [...value, list.nextCursor!]);
                setList(undefined);
              }
            }}
          />
        </aside>
        <main className="detail" hidden={Boolean(reportId)} aria-label="Interaction detail">
          {!selected && (
            <div className="empty-selection">
              <History size={32} />
              <h2>Select an interaction</h2>
              <p>Requests, saved activity, and reports</p>
            </div>
          )}
          {selected && (
            <>
              <button
                className="command back-mobile"
                onClick={() => {
                  setSelected(undefined);
                }}
              >
                <ArrowLeft size={16} />
                Interactions
              </button>
              <div className="detail-heading">
                <span className="eyebrow">INTERACTION</span>
                <h2>{selectedTitle}</h2>
                <p className="identifier">{selected}</p>
              </div>
              {!detail && (
                <p className="empty">
                  {error ? "Interaction unavailable" : "Loading saved activity..."}
                </p>
              )}
              {detail && !detail.found && <p className="empty">{detail.reason}</p>}
              {interaction && (
                <>
                  <div className="outcomes">
                    <div>
                      <span>Execution</span>
                      <Badge kind={interaction.status}>{interaction.status}</Badge>
                    </div>
                    <div>
                      <span>Delivery attempts</span>
                      <strong>
                        {interaction.delivery.acknowledged} acknowledged /{" "}
                        {interaction.delivery.failed} failed
                      </strong>
                      <small>
                        {interaction.delivery.pending} pending / {interaction.delivery.uncertain}{" "}
                        uncertain
                      </small>
                    </div>
                    <div>
                      <span>Capture</span>
                      <strong className={interaction.incomplete ? "warning-text" : ""}>
                        {interaction.incomplete ? "Incomplete" : "No gaps flagged"}
                      </strong>
                    </div>
                    <div>
                      <span>Model usage</span>
                      <strong>
                        {interaction.usage.knownCalls
                          ? `${count(interaction.usage.totalTokens)} known tokens`
                          : "Unknown / not observed"}
                      </strong>
                      <small>
                        {interaction.usage.knownCalls} known / {interaction.usage.unknownCalls}{" "}
                        unknown calls
                      </small>
                    </div>
                  </div>
                  {interaction.status === "running" && (
                    <p className="notice">
                      Saved status: running. Process ownership: {interaction.ownership}. This is not
                      a live execution heartbeat.
                    </p>
                  )}
                  <dl className="metadata">
                    <dt>Source</dt>
                    <dd>{interaction.source}</dd>
                    <dt>Target</dt>
                    <dd>{interaction.target ?? "No target"}</dd>
                    <dt>Started</dt>
                    <dd>{time(interaction.startedAt)}</dd>
                    <dt>Finished</dt>
                    <dd>{time(interaction.finishedAt)}</dd>
                  </dl>
                  {interaction.error && (
                    <section>
                      <h3>Failure reason</h3>
                      <Capture value={interaction.error} />
                    </section>
                  )}
                  <section>
                    <h3>
                      Conversation <small>this activity page</small>
                    </h3>
                    {messages.length === 0 && <p className="muted">No messages on this page.</p>}
                    {messages.map((item) => (
                      <article className="message" key={item.key}>
                        <h4>{item.record.role === "user" ? "Request" : "Response"}</h4>
                        <Capture value={item.record.content} />
                      </article>
                    ))}
                  </section>
                  {artifacts.length > 0 && (
                    <section>
                      <h3>Reports</h3>
                      {artifacts.map((item) => (
                        <div className="report-link" key={item.key}>
                          <FileText size={18} />
                          <span>{item.record.title ?? item.record.path.split("/").at(-1)}</span>
                          <button
                            className="command"
                            disabled={item.record.type !== "markdown"}
                            onClick={() => {
                              openReport(item.record.id);
                            }}
                          >
                            Read report
                          </button>
                        </div>
                      ))}
                    </section>
                  )}
                  <section>
                    <h3>
                      Activity <small>this page</small>
                    </h3>
                    <p className="counts">
                      {tools.filter((item) => item.record.kind === "capability").length} capability
                      /{" "}
                      {
                        tools.filter((item) => ["dispatch", "discovery"].includes(item.record.kind))
                          .length
                      }{" "}
                      catalog / {tools.filter((item) => item.record.kind === "workflow").length}{" "}
                      workflow
                    </p>
                    {items
                      .filter((item) => item.kind !== "message")
                      .map((item) => (
                        <Activity
                          key={item.key}
                          item={item}
                          expanded={expanded.has(item.key)}
                          toggle={() => {
                            setExpanded((previous) => {
                              const next = new Set(previous);
                              if (next.has(item.key)) next.delete(item.key);
                              else next.add(item.key);
                              return next;
                            });
                          }}
                          openReport={openReport}
                        />
                      ))}
                  </section>
                  <Pager
                    label={`Activity page ${activityPages.length}`}
                    previous={activityPages.length > 1}
                    next={Boolean(current?.activity.nextCursor)}
                    onPrevious={() => {
                      setActivityPages((value) => value.slice(0, -1));
                      setDetail(undefined);
                    }}
                    onNext={() => {
                      if (current?.activity.nextCursor) {
                        setActivityPages((value) => [...value, current.activity.nextCursor!]);
                        setDetail(undefined);
                      }
                    }}
                  />
                </>
              )}
            </>
          )}
        </main>
        {reportId && (
          <main className="report-reader" aria-label="Report reader">
            <div className="report-toolbar">
              <button
                className="command"
                onClick={() => {
                  setReportId(undefined);
                }}
              >
                <ArrowLeft size={16} />
                Back to interaction
              </button>
              <span>MARKDOWN REPORT</span>
            </div>
            {!report && <p>{error ? "Report unavailable" : "Loading report..."}</p>}
            {report && !report.available && (
              <div role="status">
                <h2>Report unavailable</h2>
                <p>{report.reason}</p>
              </div>
            )}
            {report?.available && (
              <>
                <p className="path">{report.path}</p>
                {report.truncated && <p className="notice">Report truncated at 256 KiB.</p>}
                <article className="markdown">
                  <Markdown
                    skipHtml
                    components={{
                      img: ({ alt }) => (
                        <span className="notice">[Image not loaded: {alt ?? "image"}]</span>
                      ),
                      a: ({ children }) => <span className="inert-link">{children}</span>
                    }}
                  >
                    {report.content}
                  </Markdown>
                </article>
              </>
            )}
          </main>
        )}
      </div>
    </div>
  );
}

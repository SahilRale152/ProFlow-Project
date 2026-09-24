import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  ClipboardList,
  Download,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { api, getAuthToken } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface AiLlmSearch {
  source?: "customer" | "tender";
  id?: number;
}

export const Route = createFileRoute("/_authenticated/ai-llm")({
  validateSearch: (search: Record<string, unknown>): AiLlmSearch => ({
    source: search.source === "tender" ? "tender" : search.source === "customer" ? "customer" : undefined,
    id: search.id ? Number(search.id) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "AI Company Research — OrbitAvanya CRM" },
      { name: "description", content: "AI research for proposal prep." },
    ],
  }),
  component: AiLlmPage,
});

/* ---------------- Layout header (matches Tender Customers page) ---------------- */

function LocalPageHeader({
  title,
  description,
  icon: Icon,
  actions,
}: {
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  actions?: ReactNode;
}) {
  return (
    <div className="border-b bg-background">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-6 py-6">
        <div className="flex min-w-0 items-center gap-3">
          {Icon ? (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </div>
          ) : null}
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
    </div>
  );
}

/* ---------------- Report renderer ----------------
   Dependency-free markdown-ish renderer tuned to the shape the AI is
   prompted to produce: #/##/### headings, **bold**, "- " bullets, plain
   paragraphs, and numbered findings ("### 1. Title" followed by a
   "Priority: HIGH" line) — those get pulled out into their own highlighted,
   color-coded card instead of blending into plain paragraphs. */

type Priority = "high" | "medium" | "low" | null;

const priorityBadgeClass: Record<string, string> = {
  high: "bg-red-100 text-red-700 hover:bg-red-100",
  medium: "bg-amber-100 text-amber-700 hover:bg-amber-100",
  low: "bg-slate-100 text-slate-700 hover:bg-slate-100",
};

const priorityBorderClass: Record<string, string> = {
  high: "border-l-red-400",
  medium: "border-l-amber-400",
  low: "border-l-slate-300",
};

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
}

function extractPriority(line: string): Priority {
  const m = line.match(/priority\s*:?\**\s*(high|medium|low)/i);
  if (!m) return null;
  return m[1].toLowerCase() as Priority;
}

function renderBodyLines(lines: string[], keyPrefix: string): ReactNode {
  const blocks: ReactNode[] = [];
  let listBuffer: string[] = [];

  const flushList = (key: string) => {
    if (listBuffer.length === 0) return;
    blocks.push(
      <ul key={key} className="my-2 list-outside list-disc space-y-1 pl-5">
        {listBuffer.map((item, i) => (
          <li key={i} className="text-[14.5px] leading-relaxed text-foreground/90">
            {renderInline(item, `${key}-${i}`)}
          </li>
        ))}
      </ul>
    );
    listBuffer = [];
  };

  lines.forEach((raw, idx) => {
    const line = raw.trim();
    const key = `${keyPrefix}-l${idx}`;
    if (!line) {
      flushList(`ul-${key}`);
      return;
    }
    if (extractPriority(line)) return; // already surfaced as the card's badge
    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      listBuffer.push(bulletMatch[1]);
      return;
    }
    flushList(`ul-${key}`);
    blocks.push(
      <p key={key} className="my-2 text-[14.5px] leading-relaxed text-foreground/90">
        {renderInline(line, key)}
      </p>
    );
  });
  flushList(`ul-${keyPrefix}-end`);

  return <>{blocks}</>;
}

function ReportBlock({ content }: { content: string }) {
  if (!content) return null;
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const elements: ReactNode[] = [];
  const topListBuffer: string[] = [];

  const flushTopList = (key: string) => {
    if (topListBuffer.length === 0) return;
    elements.push(
      <ul key={key} className="my-3 list-outside list-disc space-y-1.5 pl-6">
        {topListBuffer.map((item, i) => (
          <li key={i} className="text-[15px] leading-relaxed text-foreground/90">
            {renderInline(item, `${key}-${i}`)}
          </li>
        ))}
      </ul>
    );
    topListBuffer.length = 0;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const key = `t-${i}`;

    if (!line) {
      flushTopList(`ultop-${key}`);
      i++;
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      topListBuffer.push(bulletMatch[1]);
      i++;
      continue;
    }
    flushTopList(`ultop-${key}`);

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const isNumberedFinding = level >= 3 && /^\d+\.\s+/.test(text);

      if (isNumberedFinding) {
        // Gather this finding's body until the next heading line.
        const body: string[] = [];
        let priority: Priority = null;
        let j = i + 1;
        while (j < lines.length && !/^#{1,4}\s+/.test(lines[j].trim())) {
          const bLine = lines[j].trim();
          if (bLine) {
            const p = extractPriority(bLine);
            if (p && !priority) priority = p;
          }
          body.push(lines[j]);
          j++;
        }
        elements.push(
          <div
            key={key}
            className={`my-4 rounded-r-lg border-l-4 bg-muted/30 py-3 pl-4 pr-4 ${
              priorityBorderClass[priority || ""] || "border-l-slate-300"
            }`}
          >
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold">{renderInline(text, key)}</span>
              {priority && (
                <Badge className={priorityBadgeClass[priority] || priorityBadgeClass.low}>
                  {priority}
                </Badge>
              )}
            </div>
            {renderBodyLines(body, key)}
          </div>
        );
        i = j;
        continue;
      }

      if (level === 1) {
        elements.push(
          <h2 key={key} className="mt-7 mb-2 border-b pb-2 text-xl font-semibold tracking-tight first:mt-0">
            {renderInline(text, key)}
          </h2>
        );
      } else if (level === 2) {
        elements.push(
          <h3 key={key} className="mt-6 mb-2 text-lg font-semibold tracking-tight first:mt-0">
            {renderInline(text, key)}
          </h3>
        );
      } else {
        elements.push(
          <h4 key={key} className="mt-4 mb-1.5 text-base font-semibold first:mt-0">
            {renderInline(text, key)}
          </h4>
        );
      }
      i++;
      continue;
    }

    elements.push(
      <p key={key} className="my-2.5 text-[15px] leading-relaxed text-foreground/90">
        {renderInline(line, key)}
      </p>
    );
    i++;
  }
  flushTopList("ultop-end");

  return <div>{elements}</div>;
}

/* ---------------- Types ---------------- */

type SourceType = "customer" | "tender";

interface RecommendedService {
  service_name: string;
  reason: string;
  priority: "high" | "medium" | "low";
}

type FactType = "verified" | "inferred" | "assumption";

interface Finding {
  id?: number;
  title: string;
  body?: string;
  fact_type: FactType;
  priority?: "high" | "medium" | "low";
}

interface PainPointDetailed {
  id?: number;
  title: string;
  description?: string;
  priority?: "high" | "medium" | "low";
}

interface Opportunity {
  id?: number;
  service_name: string;
  reason?: string;
  priority?: "high" | "medium" | "low";
}

interface ProposalTopic {
  id?: number;
  proposal_topic?: string;
  topic?: string;
  proposal_type?: string;
  type?: string;
  pitch_summary?: string;
  pitch?: string;
}

interface ResearchResult {
  id: number;
  source: SourceType;
  company_id: number;
  company_name: string;
  company_category?: string;
  company_needs_summary?: string;
  summary: string;
  detailed_report?: string;
  pain_points: string[];
  pain_points_detailed?: PainPointDetailed[];
  findings?: Finding[];
  opportunities?: Opportunity[];
  proposal_topics?: ProposalTopic[];
  recommended_services: RecommendedService[];
  recommended_pricing_tier: string;
  proposal_intro: string;
  web_sources?: { title: string; url: string }[];
  created_at: string;
}

const factTypeBadgeClass: Record<FactType, string> = {
  verified: "bg-emerald-100 text-emerald-700 hover:bg-emerald-100",
  inferred: "bg-blue-100 text-blue-700 hover:bg-blue-100",
  assumption: "bg-orange-100 text-orange-700 hover:bg-orange-100",
};

const factTypeLabel: Record<FactType, string> = {
  verified: "Verified",
  inferred: "Inferred",
  assumption: "Assumption",
};

interface LogRow {
  Timestamp: string;
  Source: string;
  CompanyID: string | number;
  CompanyName: string;
  CompanyCategory?: string;
  CompanyNeeds?: string;
  TopPriority: string;
  Summary: string;
  DetailedReport?: string;
  VerifiedFindings?: string;
  InferredFindings?: string;
  Assumptions?: string;
  PainPoints?: string;
  RecommendedServices?: string;
  ProposalTopics?: string;
  RecommendedPricingTier?: string;
  ProposalIntro?: string;
  WebSources?: string;
  Model?: string;
}

/* ---------------- Page ---------------- */

function AiLlmPage() {
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  // Company + source now come entirely from the URL (?source=&id=) — set
  // when you click the star / "Selected for proposal" on a company in
  // Customers or Tender Customers, which brings you straight here. No more
  // manual picker on this page.
  const sourceType: SourceType = search.source || "customer";
  const companyId: number | null = search.id ?? null;
  const [autoRan, setAutoRan] = useState(false);

  const existingResearchQuery = useQuery({
    queryKey: ["ai-llm-research", sourceType, companyId],
    queryFn: () =>
      api(`/api/research/${sourceType}/${companyId}`).then(
        (data: { research: ResearchResult }) => data.research
      ),
    enabled: Boolean(companyId) && !Number.isNaN(companyId),
    retry: false,
  });

  const logPreviewQuery = useQuery({
    queryKey: ["ai-llm-log-preview"],
    queryFn: () => api("/api/research/export/preview?limit=10").then((data: { rows: LogRow[] }) => data.rows),
  });

  const generateMutation = useMutation({
    mutationFn: () => {
      if (!companyId) {
        return Promise.reject(new Error("A valid company id is required."));
      }
      return api("/api/research/generate", {
        method: "POST",
        body: JSON.stringify({ source: sourceType, id: companyId }),
      }).then((data) => data as { research: ResearchResult; excel?: { written: boolean; reason?: string } });
    },
    onSuccess: (data) => {
      if (data.excel && data.excel.written === false) {
        toast.warning(data.excel.reason || "Research saved, but the Excel log could not be updated.");
      } else {
        toast.success("Research complete — saved to the Excel log too.");
      }
      queryClient.setQueryData(["ai-llm-research", sourceType, companyId], data.research);
      queryClient.invalidateQueries({ queryKey: ["ai-llm-log-preview"] });
    },
    onError: (err: any) => {
      toast.error(err.message || "Research failed.");
    },
  });

  const result = generateMutation.data?.research || existingResearchQuery.data;

  useEffect(() => {
    // Deep link from Customers / Tender Customers ("Research with AI") —
    // run automatically once, but only if nothing's been researched yet.
    if (!autoRan && search.id && !existingResearchQuery.isLoading && !existingResearchQuery.data) {
      setAutoRan(true);
      generateMutation.mutate();
    }
  }, [autoRan, search.id, existingResearchQuery.isLoading, existingResearchQuery.data])

  const downloadExcelLog = async () => {
    const token = getAuthToken();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

    // Try the same relative path every other working call on this page
    // uses; if that doesn't actually reach the backend (e.g. no dev-server
    // proxy configured — it'd come back as the frontend's own HTML instead
    // of a spreadsheet), fall back to the backend's direct port. Trying
    // both means this works either way instead of silently doing nothing.
    const candidates = ["/api/research/export/excel", "http://localhost:5000/api/research/export/excel"];

    let lastError: string | null = null;
    for (const url of candidates) {
      try {
        const res = await fetch(url, { headers });
        const contentType = res.headers.get("content-type") || "";
        if (!res.ok) {
          const body = contentType.includes("json") ? await res.json().catch(() => null) : null;
          lastError = body?.message || `Request to ${url} failed (${res.status}).`;
          continue;
        }
        if (contentType.includes("html")) {
          // Hit a frontend dev-server fallback page, not the real backend.
          lastError = `${url} did not reach the backend (got a webpage back instead of a file).`;
          continue;
        }
        const blob = await res.blob();
        const objectUrl = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = "company_research_log.xlsx";
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(objectUrl);
        return; // success — stop trying further candidates
      } catch (err: any) {
        lastError = err.message || `Could not reach ${url}.`;
      }
    }
    console.error("[AI LLM] Excel download failed on all candidate URLs:", lastError);
    toast.error(lastError || "Download failed.");
  };

  const syncAllMutation = useMutation({
    mutationFn: () =>
      api("/api/research/export/sync-all", { method: "POST" }).then(
        (data) => data as { excel?: { written: boolean; reason?: string }; synced?: number }
      ),
    onSuccess: (data) => {
      if (data.excel && data.excel.written === false) {
        toast.warning(data.excel.reason || "Could not sync to the Excel log.");
      } else {
        toast.success(`Synced ${data.synced ?? 0} researched compan${data.synced === 1 ? "y" : "ies"} to the Excel log.`);
      }
      queryClient.invalidateQueries({ queryKey: ["ai-llm-log-preview"] });
    },
    onError: (err: any) => {
      toast.error(err.message || "Sync all failed.");
    },
  });

  return (
    <div>
      <LocalPageHeader
        title="AI Company Research"
        description="Star a company as 'Selected for proposal' in Customers or Tender Customers to research it here — AI matches your services to their likely needs and auto-saves to the Excel log. Use Sync all to Excel any time to make sure every researched company is in the log."
        icon={Sparkles}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncAllMutation.mutate()}
              disabled={syncAllMutation.isPending}
              title="Push every company you've ever researched into the Excel log — catches up any that were only viewed, not freshly run or synced individually"
            >
              {syncAllMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {syncAllMutation.isPending ? "Syncing all…" : "Sync all to Excel"}
            </Button>
            <Button variant="outline" size="sm" onClick={downloadExcelLog}>
              <Download className="mr-2 h-4 w-4" />
              Download research log (xlsx)
            </Button>
          </div>
        }
      />

      <div className="mx-auto max-w-[1600px] space-y-4 px-6 py-6">
        {!companyId ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
              <Sparkles className="h-8 w-8 text-muted-foreground" />
              <p className="font-medium">No company selected</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Click the star / "Selected for proposal" action on a company in{" "}
                <span className="font-medium">Customers</span> or{" "}
                <span className="font-medium">Tender Customers</span> — that brings you straight
                here and starts the research automatically.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex flex-col flex-wrap gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline" className="capitalize">
                  {sourceType === "customer" ? "Customer" : "Tender Customer"}
                </Badge>
                {result?.company_name && <span className="font-medium text-foreground">{result.company_name}</span>}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => generateMutation.mutate()}
                  disabled={generateMutation.isPending}
                  className="shrink-0 gap-2 sm:w-auto"
                >
                  {generateMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {generateMutation.isPending
                    ? "Researching…"
                    : result
                      ? "Re-run AI Research"
                      : "Run AI Research"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {generateMutation.isPending && !result && (
          <Card>
            <CardContent className="flex items-center gap-3 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Researching the company and drafting a full report — this can take a little while for a
              thorough writeup…
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          {result && (
            <div className="min-w-0 space-y-4">
              {/* Company info card — what the company IS + what it needs */}
              <Card>
                <CardContent className="space-y-3 pt-6">
                  <div className="flex flex-wrap items-center gap-2 border-b pb-4">
                    <Building2 className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <span className="text-lg font-semibold">{result.company_name}</span>
                    {result.company_category && (
                      <Badge variant="secondary" className="font-normal">
                        {result.company_category}
                      </Badge>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {new Date(result.created_at).toLocaleString()}
                    </span>
                  </div>
                  {result.company_needs_summary && (
                    <div>
                      <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        What they likely need
                      </div>
                      <p className="text-[14.5px] leading-relaxed text-foreground/90">
                        {result.company_needs_summary}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="space-y-4 pt-6">
                  <ReportBlock content={result.summary} />
                  {result.detailed_report && <ReportBlock content={result.detailed_report} />}
                </CardContent>
              </Card>

              {/* Findings — verified vs inferred vs assumption, per Data Quality requirement */}
              {Boolean(result.findings?.length) && (
                <Card>
                  <CardContent className="pt-6">
                    <div className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                      Findings
                    </div>
                    <div className="space-y-3">
                      {result.findings!.map((f, i) => (
                        <div key={i} className="rounded-lg border p-3">
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <span className="text-[14.5px] font-medium">{f.title}</span>
                            <Badge className={factTypeBadgeClass[f.fact_type] || factTypeBadgeClass.inferred}>
                              {factTypeLabel[f.fact_type] || f.fact_type}
                            </Badge>
                            {f.priority && (
                              <Badge className={priorityBadgeClass[f.priority] || priorityBadgeClass.low}>
                                {f.priority}
                              </Badge>
                            )}
                          </div>
                          {f.body && <p className="text-[13.5px] text-muted-foreground">{f.body}</p>}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Opportunity chain: Pain Point -> Matching Service -> Reason */}
              {Boolean(result.recommended_services?.length) && (
                <Card>
                  <CardContent className="pt-6">
                    <div className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                      Pain point → matching service → reason
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[560px] border-collapse text-[13.5px]">
                        <thead>
                          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                            <th className="py-2 pr-3 font-medium">Priority</th>
                            <th className="py-2 pr-3 font-medium">Matching service</th>
                            <th className="py-2 font-medium">Reason / opportunity</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.recommended_services.map((s, i) => (
                            <tr key={i} className="border-b last:border-b-0">
                              <td className="py-2.5 pr-3 align-top">
                                <Badge className={priorityBadgeClass[s.priority] || priorityBadgeClass.low}>
                                  {s.priority}
                                </Badge>
                              </td>
                              <td className="py-2.5 pr-3 align-top font-medium">{s.service_name}</td>
                              <td className="py-2.5 align-top text-foreground/90">{s.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Proposal topic suggestions */}
              {Boolean(result.proposal_topics?.length) && (
                <Card>
                  <CardContent className="pt-6">
                    <div className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                      Suggested proposal topics
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {result.proposal_topics!.map((t, i) => (
                        <div key={i} className="rounded-lg border p-3">
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <span className="text-[14.5px] font-medium">{t.proposal_topic || t.topic}</span>
                            {(t.proposal_type || t.type) && (
                              <Badge variant="secondary" className="shrink-0 font-normal">
                                {t.proposal_type || t.type}
                              </Badge>
                            )}
                          </div>
                          {(t.pitch_summary || t.pitch) && (
                            <p className="text-[13.5px] text-muted-foreground">{t.pitch_summary || t.pitch}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardContent className="space-y-4 pt-6">
                  {result.recommended_pricing_tier && (
                    <div>
                      <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        Suggested starting pricing tier
                      </div>
                      <p className="text-[14.5px] text-foreground/90">{result.recommended_pricing_tier}</p>
                    </div>
                  )}

                  {Boolean(result.web_sources?.length) && (
                    <div className="border-t pt-4 first:border-t-0 first:pt-0">
                      <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        Live sources used
                      </div>
                      <ul className="space-y-0.5 text-xs">
                        {result.web_sources!.map((s, i) => (
                          <li key={i}>
                            <a href={s.url} target="_blank" rel="noreferrer" className="text-primary underline">
                              {s.title || s.url}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Live preview of the Excel log — "auto update so I can see it" */}
          <Card className="h-fit xl:sticky xl:top-6">
            <CardContent className="pt-6">
              <div className="mb-3 flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Recent research log</span>
              </div>
              {!logPreviewQuery.data?.length ? (
                <p className="text-xs text-muted-foreground">
                  Nothing logged yet — run your first research above.
                </p>
              ) : (
                <div className="space-y-3">
                  {logPreviewQuery.data.map((row, i) => (
                    <div
                      key={i}
                      className="cursor-pointer border-b pb-2.5 last:border-b-0 last:pb-0 transition-colors hover:bg-muted/50 rounded-md px-1.5 -mx-1.5"
                      onClick={() => {
                        if (row.Source && row.CompanyID !== undefined && row.CompanyID !== "") {
                          window.location.href = `/ai-llm?source=${row.Source}&id=${row.CompanyID}`;
                        }
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{row.CompanyName}</span>
                        {row.TopPriority && (
                          <Badge className={priorityBadgeClass[row.TopPriority] || priorityBadgeClass.low}>
                            {row.TopPriority}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {row.Timestamp ? new Date(row.Timestamp).toLocaleString() : ""}
                      </div>
                      {row.Summary && (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{row.Summary}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
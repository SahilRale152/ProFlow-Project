import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  CheckCircle2,
  ChevronRight,
  Database,
  ExternalLink,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/_authenticated/tender-customers")({
  head: () => ({
    meta: [
      { title: "Tender Customers — OrbitAvanya CRM" },
      {
        name: "description",
        content: "Browse and track companies imported from the tender prospect workbook.",
      },
    ],
  }),
  component: TenderCustomers,
});

type TenderCustomer = {
  id: number;
  company_name: string;
  legal_company_name?: string | null;
  company_number?: string | null;
  official_website?: string | null;
  linkedin_url?: string | null;
  company_emails?: string | null;
  executive_name?: string | null;
  executive_role?: string | null;
  executive_email?: string | null;
  primary_domain?: string | null;
  tender_domain?: string | null;
  tender_subdomain?: string | null;
  tender_count?: number;
  proposal_status: "pending" | "done";
  last_proposal_id?: number | null;
  proposal_created_at?: string | null;
  selected_for_proposal?: boolean;
  raw_data?: Record<string, unknown>;
  tender_data?: Record<string, unknown>[];
};

function formatValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

type TenderCustomersResponse = {
  customers: TenderCustomer[];
  total: number;
};

type TenderStatsResponse = {
  total: number;
  pending: number;
  done: number;
  selected: number;
  tender_rows: number;
};

type TenderDetailResponse = {
  customer: TenderCustomer;
  proposals: Array<Record<string, unknown>>;
};

type SectionItem = [label: string, value: unknown];

type DetailSection = {
  title: string;
  items: SectionItem[];
};

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
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-6">
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

function LocalStatCard({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      </CardContent>
    </Card>
  );
}

function TenderCustomers() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Row checkboxes — separate from `selectedId` above, which is the
  // "open detail modal" id. This is which companies are checked so
  // they can be sent to (or removed from) the Proposals generator.
  const [checkedIds, setCheckedIds] = useState<number[]>([]);

  const customersQuery = useQuery({
    queryKey: ["tender-customers", search, status],
    queryFn: () =>
      api(
        `/api/tender/customers?search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}&limit=500`
      ).then((data) => data as TenderCustomersResponse),
  });

  const statsQuery = useQuery({
    queryKey: ["tender-stats"],
    queryFn: () => api("/api/tender/stats").then((data) => data as TenderStatsResponse),
  });

  const detailQuery = useQuery({
    queryKey: ["tender-customer", selectedId],
    queryFn: () => api(`/api/tender/customers/${selectedId}`).then((data) => data as TenderDetailResponse),
    enabled: Boolean(selectedId),
  });

  const syncMutation = useMutation({
    mutationFn: () => api("/api/tender/sync", { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (data: any) => {
      toast.success(`Tender workbook synced: ${data.company_count || 0} companies.`);
      qc.invalidateQueries({ queryKey: ["tender-customers"] });
      qc.invalidateQueries({ queryKey: ["tender-stats"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Marks/unmarks the checked companies as "selected for proposal" —
  // only companies marked this way appear in the Proposals generator's
  // Tender Customer dropdown.
  const selectMutation = useMutation({
    mutationFn: (selected: boolean) =>
      api("/api/tender/customers/select", {
        method: "POST",
        body: JSON.stringify({ ids: checkedIds, selected }),
      }),
    onSuccess: (data: any) => {
      toast.success(data.message || "Updated.");
      setCheckedIds([]);
      qc.invalidateQueries({ queryKey: ["tender-customers"] });
      qc.invalidateQueries({ queryKey: ["tender-stats"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = customersQuery.data?.customers || [];
  const stats = statsQuery.data;

  const visibleRows = useMemo(() => rows, [rows]);

  const allVisibleChecked =
    visibleRows.length > 0 && visibleRows.every((c) => checkedIds.includes(c.id));

  function toggleCheckAll(checked: boolean) {
    setCheckedIds(checked ? visibleRows.map((c) => c.id) : []);
  }

  function toggleCheckOne(id: number, checked: boolean) {
    setCheckedIds((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
  }

  return (
    <div className="min-h-screen bg-muted/20">
      <LocalPageHeader
        title="Tender Customers"
        description="Companies imported from your UK subcontractor and tender prospect workbook."
        icon={Database}
        actions={
          <Button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="gap-2"
          >
            {syncMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {syncMutation.isPending ? "Syncing…" : "Sync workbook"}
          </Button>
        }
      />

      <div className="mx-auto max-w-7xl space-y-5 px-6 py-6">
        <div className="grid gap-4 md:grid-cols-5">
          <LocalStatCard label="Total companies" value={stats?.total ?? "—"} />
          <LocalStatCard label="Not proposed" value={stats?.pending ?? "—"} />
          <LocalStatCard label="Proposals done" value={stats?.done ?? "—"} />
          <LocalStatCard label="Selected for proposal" value={stats?.selected ?? "—"} />
          <LocalStatCard label="Tender records" value={stats?.tender_rows ?? "—"} />
        </div>

        <Card className="shadow-sm">
          <CardHeader className="border-b pb-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <CardTitle className="text-base">Tender prospect companies</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Select a company to inspect all imported company and tender information. Check
                  the box to send companies to the Proposals generator.
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search company, number or email…"
                    className="w-full pl-9 sm:w-[280px]"
                  />
                </div>
                <div className="flex rounded-lg border bg-muted/30 p-1">
                  {[
                    ["", "All"],
                    ["pending", "Pending"],
                    ["done", "Done"],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setStatus(value)}
                      className={`rounded-md px-3 py-2 text-xs font-medium transition ${
                        status === value
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {checkedIds.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
                <span className="text-xs font-medium">
                  {checkedIds.length} compan{checkedIds.length === 1 ? "y" : "ies"} selected
                </span>
                <div className="ml-auto flex gap-2">
                  <Button
                    size="sm"
                    className="gap-1.5"
                    onClick={() => selectMutation.mutate(true)}
                    disabled={selectMutation.isPending}
                  >
                    {selectMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                    Send to Proposals
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => selectMutation.mutate(false)}
                    disabled={selectMutation.isPending}
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    Remove from Proposals
                  </Button>
                </div>
              </div>
            )}
          </CardHeader>

          <CardContent className="p-0">
            {customersQuery.isLoading ? (
              <div className="flex min-h-[240px] items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading tender companies…
              </div>
            ) : customersQuery.isError ? (
              <div className="p-8 text-center text-sm text-destructive">
                {(customersQuery.error as Error).message}
              </div>
            ) : visibleRows.length === 0 ? (
              <div className="p-10 text-center">
                <Database className="mx-auto h-8 w-8 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium">No tender customers found</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Check the search/filter or sync the workbook again.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto p-4">
                <table className="w-full min-w-[960px] table-fixed border-collapse border border-border text-sm">
                  <thead className="bg-muted/30 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="w-10 border border-border px-3 py-3 font-medium">
                        <input
                          type="checkbox"
                          checked={allVisibleChecked}
                          onChange={(e) => toggleCheckAll(e.target.checked)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </th>
                      <th className="border border-border px-5 py-3 font-medium">Company</th>
                      <th className="border border-border px-4 py-3 font-medium">Company number</th>
                      <th className="border border-border px-4 py-3 font-medium">Domain</th>
                      <th className="border border-border px-4 py-3 font-medium">Tender records</th>
                      <th className="border border-border px-4 py-3 font-medium">Proposal</th>
                      <th className="border border-border px-4 py-3 font-medium">In proposals</th>
                      <th className="border border-border px-4 py-3 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((company: TenderCustomer) => (
                      <tr
                        key={company.id}
                        className="cursor-pointer hover:bg-muted/20"
                        onClick={() => setSelectedId(company.id)}
                      >
                        <td className="border border-border px-3 py-4" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={checkedIds.includes(company.id)}
                            onChange={(e) => toggleCheckOne(company.id, e.target.checked)}
                          />
                        </td>
                        <td className="border border-border px-5 py-4">
                          <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                              {company.company_name
                                .split(/\s+/)
                                .filter(Boolean)
                                .slice(0, 2)
                                .map((x: string) => x[0])
                                .join("")
                                .toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <div className="truncate font-medium">{company.company_name}</div>
                              <div className="truncate text-xs text-muted-foreground">
                                {company.executive_name || company.company_emails || "No contact"}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="border border-border px-4 py-4 text-xs">{company.company_number || "—"}</td>
                        <td className="border border-border px-4 py-4 text-xs">
                          {company.tender_domain || company.primary_domain || "—"}
                        </td>
                        <td className="border border-border px-4 py-4">{company.tender_count || 0}</td>
                        <td className="border border-border px-4 py-4">
                          {company.proposal_status === "done" ? (
                            <Badge className="gap-1 bg-emerald-600 hover:bg-emerald-600">
                              <CheckCircle2 className="h-3 w-3" /> Done
                            </Badge>
                          ) : (
                            <Badge variant="secondary">Not proposed</Badge>
                          )}
                        </td>
                        <td className="border border-border px-4 py-4">
                          {company.selected_for_proposal ? (
                            <Badge className="gap-1 bg-blue-600 hover:bg-blue-600">
                              <Send className="h-3 w-3" /> Selected
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="border border-border px-4 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              variant="outline"
                              size="icon"
                              title="Research with AI"
                              onClick={() =>
                                navigate({ to: "/ai-llm", search: { source: "tender", id: company.id } as any })
                              }
                            >
                              <Sparkles className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1"
                              onClick={() => setSelectedId(company.id)}
                            >
                              View <ChevronRight className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {selectedId && (
        <div className="fixed inset-0 z-50 bg-black/40 p-4 md:p-8">
          <div className="mx-auto flex h-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-background shadow-2xl">
            <div className="flex items-start justify-between border-b px-5 py-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">
                    {detailQuery.data?.customer?.company_name || "Tender customer"}
                  </h2>
                  {detailQuery.data?.customer?.proposal_status === "done" && (
                    <Badge className="bg-emerald-600 hover:bg-emerald-600">Proposal done</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Full workbook record and tender history
                </p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setSelectedId(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {detailQuery.isLoading ? (
                <div className="flex min-h-[300px] items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading company details…
                </div>
              ) : detailQuery.isError ? (
                <div className="text-sm text-destructive">{(detailQuery.error as Error).message}</div>
              ) : detailQuery.data?.customer ? (
                <TenderCustomerDetail
                  customer={detailQuery.data.customer}
                  proposals={detailQuery.data.proposals || []}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TenderCustomerDetail({
  customer,
  proposals,
}: {
  customer: TenderCustomer;
  proposals: Array<Record<string, unknown>>;
}) {
  const sections: DetailSection[] = [
    {
      title: "Company",
      items: [
        ["Company name", customer.company_name],
        ["Legal company name", customer.legal_company_name],
        ["Company number", customer.company_number],
        ["Official website", customer.official_website],
        ["LinkedIn", customer.linkedin_url],
        ["Primary domain", customer.primary_domain],
      ],
    },
    {
      title: "Contacts",
      items: [
        ["Company emails", customer.company_emails],
        ["Executive", customer.executive_name],
        ["Executive role", customer.executive_role],
        ["Executive email", customer.executive_email],
        ["Procurement emails", customer.raw_data?.PROCUREMENT_EMAILS],
        ["Supplier emails", customer.raw_data?.SUPPLIER_EMAILS],
        ["Subcontracting emails", customer.raw_data?.SUBCONTRACTING_EMAILS],
        ["Teaming emails", customer.raw_data?.TEAMING_EMAILS],
        ["Partnership emails", customer.raw_data?.PARTNERSHIP_EMAILS],
      ],
    },
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Proposal status</div>
            <div className="mt-2 text-sm font-semibold">
              {customer.proposal_status === "done" ? "Done" : "Not proposed"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Tender records</div>
            <div className="mt-2 text-sm font-semibold">{customer.tender_count || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Last proposal</div>
            <div className="mt-2 text-sm font-semibold">
              {customer.proposal_created_at
                ? new Date(customer.proposal_created_at).toLocaleString()
                : "—"}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {sections.map((section) => (
          <Card key={section.title}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">{section.title}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {section.items.map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {label}
                  </div>
                  <div className="mt-1 break-words text-sm">{formatValue(value)}</div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">All workbook fields</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(customer.raw_data || {}).map(([key, value]) => (
              <div key={key} className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {key.replace(/_/g, " ")}
                </div>
                <div className="mt-1 break-words text-xs leading-relaxed">{formatValue(value)}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Tender history ({customer.tender_data?.length || 0})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(customer.tender_data || []).map((row, index) => (
            <div key={index} className="rounded-xl border p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold">
                  {formatValue(row.TENDER_TITLE || row.TENDER_ID || `Tender ${index + 1}`)}
                </div>
                <Badge variant="outline">{formatValue(row.TENDER_RELEVANCE || "—")}</Badge>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(row).map(([key, value]) => (
                  <div key={key} className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {key.replace(/_/g, " ")}
                    </div>
                    <div className="mt-1 break-words text-xs">{formatValue(value)}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Proposal history</CardTitle>
        </CardHeader>
        <CardContent>
          {proposals.length === 0 ? (
            <div className="text-sm text-muted-foreground">No proposal has been generated for this company yet.</div>
          ) : (
            <div className="space-y-2">
              {proposals.map((proposal: Record<string, unknown>, index: number) => (
                <div key={String(proposal.id ?? index)} className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <div className="text-sm font-medium">{formatValue(proposal.proposal_number)}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatValue(proposal.opportunity || "Proposal")} · {proposal.created_at ? new Date(String(proposal.created_at)).toLocaleString() : "—"}
                    </div>
                  </div>
                  {proposal.file_url ? (
                    <Button variant="outline" size="sm" asChild>
                      <a href={String(proposal.file_url)} target="_blank" rel="noreferrer">
                        <ExternalLink className="mr-2 h-3.5 w-3.5" /> Open
                      </a>
                    </Button>
                  ) : (
                    <Badge variant="secondary">{formatValue(proposal.status || "Draft")}</Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
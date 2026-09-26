import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/PageBits";
import { ThemeColorPicker } from "@/components/ThemeColorPicker";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, LineChart, Line, ReferenceDot,
} from "recharts";
import {
  Users, Target, Wallet, Trophy, Gauge, FileText, RefreshCw, Bell,
  Package, MessageSquare, TrendingUp,
} from "lucide-react";
import { money } from "@/lib/currency";
import { getAuthToken } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — OrbitAvanya CRM" }, { name: "description", content: "Your sales command center." }] }),
  component: Dashboard,
});

/* ------------------------------------------------------------------ */
/* Fetch helper — same API_BASE convention used by customers.tsx,     */
/* documents.tsx, auth.ts, etc. Falls back to same-origin locally,    */
/* but resolves to the deployed backend when VITE_API_URL is set.     */
/* ------------------------------------------------------------------ */
const API_BASE =
  (typeof window !== "undefined" && (window as any).__NOVA_API_BASE__) ||
  import.meta.env.VITE_API_URL ||
  "";

async function fetchJson(path: string) {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${res.status}): ${path}`);
  }
  return res.json();
}

const PIPELINE_STAGES = ["Prospecting", "Qualification", "Proposal", "Negotiation", "Closed Won", "Closed Lost"];
const OPEN_STAGES = ["Prospecting", "Qualification", "Proposal", "Negotiation"];

// Same palette used on the Analytics page — keep every chart in the app consistent.
const PALETTE = [
  "oklch(0.63 0.22 300)", // violet (brand accent)
  "oklch(0.68 0.19 250)", // blue
  "oklch(0.72 0.17 195)", // teal
  "oklch(0.74 0.19 145)", // green
  "oklch(0.78 0.18 85)",  // amber
  "oklch(0.66 0.21 25)",  // rose
  "oklch(0.62 0.20 340)", // pink
  "oklch(0.70 0.14 260)", // indigo
];

const tooltipStyle = {
  background: "oklch(0.21 0.05 285)",
  border: "1px solid oklch(0.32 0.06 290 / 55%)",
  borderRadius: 8,
  color: "oklch(0.92 0.02 290)",
  fontSize: 12,
};
const axisColor = "oklch(0.72 0.04 290)";

/* ------------------------------------------------------------------ */
/* Small popup — a quick overview, not a full data table. Shows a     */
/* couple of stats plus the first few rows, with a "+N more" footer.  */
/* ------------------------------------------------------------------ */
type DrillItem = { label: string; value?: string; meta?: string };
type Drill = { title: string; subtitle?: string; items: DrillItem[]; totalCount: number } | null;

function DrillDialog({ drill, onClose }: { drill: Drill; onClose: () => void }) {
  const shown = drill?.items.slice(0, 6) ?? [];
  const remaining = (drill?.totalCount ?? 0) - shown.length;
  return (
    <Dialog open={!!drill} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle>{drill?.title}</DialogTitle>
          {drill?.subtitle && <p className="text-sm text-muted-foreground">{drill.subtitle}</p>}
        </DialogHeader>
        {!shown.length ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Nothing to show here yet.</p>
        ) : (
          <div className="space-y-1.5">
            {shown.map((item, i) => (
              <div key={i} className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{item.label}</div>
                    {item.meta && <div className="truncate text-xs text-muted-foreground">{item.meta}</div>}
                  </div>
                </div>
                {item.value && <div className="shrink-0 text-xs font-semibold text-primary">{item.value}</div>}
              </div>
            ))}
            {remaining > 0 && (
              <p className="pt-1 text-center text-xs text-muted-foreground">+{remaining} more</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Hero stat card — the big gradient tiles at the top, like a "ticket */
/* metrics" style dashboard. Two are shown, each with its own tone.   */
/* ------------------------------------------------------------------ */
function HeroStat({
  icon: Icon, label, value, sub, tone, onClick,
}: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: React.ReactNode; sub?: string;
  tone: "violet" | "teal"; onClick?: () => void;
}) {
  const gradient = tone === "violet"
    ? "linear-gradient(135deg, oklch(0.55 0.24 305), oklch(0.50 0.20 265))"
    : "linear-gradient(135deg, oklch(0.62 0.17 195), oklch(0.58 0.19 155))";
  return (
    <Card
      role={onClick ? "button" : undefined}
      onClick={onClick}
      className={`relative overflow-hidden rounded-2xl border-0 p-5 text-white shadow-lg transition-transform duration-200 ${onClick ? "cursor-pointer hover:scale-[1.02] active:scale-[0.99]" : ""}`}
      style={{ background: gradient }}
    >
      <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-xl bg-white/15">
        <Icon className="h-5 w-5" />
      </div>
      <div className="text-2xl font-bold tracking-tight">{value}</div>
      <div className="mt-1 text-xs text-white/80">{label}</div>
      {sub && <div className="mt-1 text-[11px] text-white/70">{sub}</div>}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Small pill stat — the compact chip style ("Messages -20%") used    */
/* alongside the hero cards for secondary numbers.                    */
/* ------------------------------------------------------------------ */
function PillStat({
  icon: Icon, label, value, onClick,
}: { icon: React.ComponentType<{ className?: string }>; label: string; value: React.ReactNode; onClick?: () => void }) {
  return (
    <Card
      role={onClick ? "button" : undefined}
      onClick={onClick}
      className={`glass flex items-center gap-3 rounded-2xl p-4 transition-transform duration-200 ${onClick ? "cursor-pointer hover:scale-[1.03]" : ""}`}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-base font-semibold">{value}</div>
        <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Donut with a side legend — matches the "Tickets By Type" style:    */
/* thick ring + big centered total on the left, labelled dots on the  */
/* right with their share of the whole.                               */
/* ------------------------------------------------------------------ */
function SideLegendDonut({
  data, onSliceClick, centerLabel = "Total",
}: { data: { name: string; value: number }[]; onSliceClick?: (name: string) => void; centerLabel?: string }) {
  const [active, setActive] = useState<number | undefined>(undefined);
  const total = data.reduce((s, d) => s + d.value, 0);

  if (!data.length || total === 0) {
    return <div className="flex h-[180px] items-center justify-center text-sm text-muted-foreground">No data yet.</div>;
  }

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[180px] w-[180px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={58}
              outerRadius={82}
              paddingAngle={3}
              cornerRadius={6}
              onMouseEnter={(_, i) => setActive(i)}
              onMouseLeave={() => setActive(undefined)}
              onClick={(d) => onSliceClick?.(d.name)}
              style={{ cursor: onSliceClick ? "pointer" : "default" }}
              isAnimationActive
            >
              {data.map((entry, i) => (
                <Cell
                  key={entry.name}
                  fill={PALETTE[i % PALETTE.length]}
                  stroke="oklch(0.18 0.03 285)"
                  strokeWidth={2}
                  opacity={active === undefined || active === i ? 1 : 0.4}
                  style={{ transition: "opacity 150ms" }}
                />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [`${v} (${total ? Math.round((v / total) * 100) : 0}%)`, n]} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold">{total}</span>
          <span className="text-[10px] text-muted-foreground">{centerLabel}</span>
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {data.map((d, i) => (
          <button
            key={d.name}
            onClick={() => onSliceClick?.(d.name)}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(undefined)}
            className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${onSliceClick ? "hover:bg-muted/40" : ""}`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
              <span className="truncate">{d.name}</span>
            </span>
            <span className="shrink-0 font-semibold text-muted-foreground">{total ? Math.round((d.value / total) * 100) : 0}%</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ================================================================== */

function Dashboard() {
  const [days, setDays] = useState<number | null>(30);
  const [drill, setDrill] = useState<Drill>(null);

  const { data, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => {
      const [customers, leads, opportunities, proposals] = await Promise.all([
        fetchJson("/api/customers"),
        fetchJson("/api/leads"),
        fetchJson("/api/opportunities"),
        fetchJson("/api/proposals"),
      ]);
      return {
        customers: Array.isArray(customers) ? customers : [],
        leads: Array.isArray(leads) ? leads : [],
        opportunities: Array.isArray(opportunities) ? opportunities : [],
        proposals: Array.isArray(proposals) ? proposals : [],
      };
    },
    refetchInterval: 30000,
  });

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["dashboard-analytics", days],
    queryFn: () => fetchJson(`/api/analytics/summary${days ? `?days=${days}` : ""}`),
    refetchInterval: 30000,
  });

  const { data: extra } = useQuery({
    queryKey: ["dashboard-extra"],
    queryFn: async () => {
      const [comms, products, notifSummary, notifUnread] = await Promise.all([
        fetchJson("/api/communications/summary").catch(() => null),
        fetchJson("/api/products/summary").catch(() => null),
        fetchJson("/api/notifications/summary").catch(() => null),
        fetchJson("/api/notifications?unread=true").catch(() => []),
      ]);
      return { comms, products, notifSummary, notifUnread: Array.isArray(notifUnread) ? notifUnread : [] };
    },
    refetchInterval: 30000,
  });

  const customers = data?.customers ?? [];
  const leads = data?.leads ?? [];
  const opportunities = data?.opportunities ?? [];
  const proposals = data?.proposals ?? [];

  const activeLeads = useMemo(() => leads.filter((l: any) => l.status !== "converted"), [leads]);

  const byStage = useMemo(() => PIPELINE_STAGES.map((stage) => {
    const inStage = opportunities.filter((o: any) => o.stage === stage);
    return { stage, count: inStage.length, value: inStage.reduce((s: number, o: any) => s + Number(o.value || 0), 0) };
  }), [opportunities]);

  const pipelineValue = useMemo(
    () => opportunities.filter((o: any) => OPEN_STAGES.includes(o.stage)).reduce((s: number, o: any) => s + Number(o.value || 0), 0),
    [opportunities]
  );

  const stageValuePie = useMemo(
    () => (summary?.by_stage ?? byStage).map((s: any) => ({ name: s.name ?? s.stage, value: Number(s.amount ?? s.value ?? 0) })).filter((s: any) => s.value > 0),
    [summary, byStage]
  );
  const sourcePie = useMemo(
    () => (summary?.lead_sources ?? []).map((s: any) => ({ name: s.source, value: s.count })),
    [summary]
  );
  const commsPie = useMemo(
    () => (extra?.comms?.by_type ?? []).map((t: any) => ({ name: t.type, value: t.count })),
    [extra]
  );
  const productsPie = useMemo(
    () => (extra?.products?.categories ?? []).map((c: any) => ({ name: c.name, value: c.count })),
    [extra]
  );

  const revenueSeries = summary?.monthly_revenue ?? [];
  const peakMonth = useMemo(
    () => revenueSeries.reduce((max: any, p: any) => (!max || p.revenue > max.revenue ? p : max), null as any),
    [revenueSeries]
  );

  const closeDrill = () => setDrill(null);

  const openOpportunitiesDrill = (title: string, subtitle: string, rows: any[]) => setDrill({
    title, subtitle, totalCount: rows.length,
    items: rows.map((o) => ({
      label: o.title || o.customer_name || `Deal #${o.id}`,
      value: money(Number(o.value || 0)),
      meta: [o.customer_name, o.stage].filter(Boolean).join(" · "),
    })),
  });

  const openLeadsDrill = (title: string, subtitle: string, rows: any[]) => setDrill({
    title, subtitle, totalCount: rows.length,
    items: rows.map((l) => ({
      label: l.title || l.customer_name || `Lead #${l.id}`,
      value: l.status,
      meta: [l.customer_name, l.source].filter(Boolean).join(" · "),
    })),
  });

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Welcome back. Here's your pipeline at a glance."
        actions={
          <div className="flex items-center gap-2">
            <select
              value={days ?? "all"}
              onChange={(e) => setDays(e.target.value === "all" ? null : Number(e.target.value))}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value="all">All time</option>
            </select>
            <button onClick={() => refetch()} className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <ThemeColorPicker />
          </div>
        }
      />

      {isError && (
        <div className="mb-4 rounded-md border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Couldn't load dashboard data{error instanceof Error ? `: ${error.message}` : "."} Check that server.js is
          running and reachable.
        </div>
      )}

      {dataUpdatedAt > 0 && (
        <p className="mb-3 text-xs text-muted-foreground">Last updated {new Date(dataUpdatedAt).toLocaleTimeString("en-IN")}</p>
      )}

      {/* ---------------- Hero row: 2 gradient tiles + 4 pill stats ---------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="grid gap-4 sm:grid-cols-2 lg:col-span-1">
          <HeroStat
            icon={Wallet}
            tone="violet"
            label="Open pipeline value"
            value={isLoading ? "…" : money(pipelineValue)}
            sub={`${opportunities.filter((o: any) => OPEN_STAGES.includes(o.stage)).length} open deals`}
            onClick={() => openOpportunitiesDrill("Open pipeline", money(pipelineValue) + " across open deals", opportunities.filter((o: any) => OPEN_STAGES.includes(o.stage)))}
          />
          <HeroStat
            icon={Trophy}
            tone="teal"
            label="Won revenue"
            value={summaryLoading ? "…" : money(summary?.won_revenue ?? 0)}
            sub={summary?.win_rate !== undefined ? `${summary.win_rate}% win rate` : undefined}
            onClick={() => openOpportunitiesDrill("Won deals", money(summary?.won_revenue ?? 0) + " in closed-won revenue", opportunities.filter((o: any) => String(o.stage).toLowerCase().includes("won")))}
          />
        </div>
        <div className="grid grid-cols-2 gap-4 lg:col-span-2">
          <PillStat
            icon={Users}
            label="Customers"
            value={isLoading ? "…" : customers.length}
            onClick={() => setDrill({
              title: "Customers", subtitle: `${customers.length} total`, totalCount: customers.length,
              items: customers.map((c: any) => ({ label: c.company_name, value: c.email, meta: c.phone })),
            })}
          />
          <PillStat
            icon={Target}
            label="Active leads"
            value={isLoading ? "…" : activeLeads.length}
            onClick={() => openLeadsDrill("Active leads", `${activeLeads.length} not yet converted`, activeLeads)}
          />
          <PillStat
            icon={FileText}
            label="Proposals"
            value={isLoading ? "…" : proposals.length}
            onClick={() => setDrill({
              title: "Proposals", subtitle: `${proposals.length} total`, totalCount: proposals.length,
              items: proposals.map((p: any) => ({
                label: p.name || p.title || p.file_name || `Proposal #${p.id}`,
                value: p.status,
                meta: p.created_at ? new Date(p.created_at).toLocaleDateString("en-IN") : undefined,
              })),
            })}
          />
          <PillStat
            icon={Gauge}
            label={summary?.forecast_next_month ? `Avg deal · fc. ${money(summary.forecast_next_month)}` : "Avg deal size"}
            value={summaryLoading ? "…" : money(summary?.avg_deal_size ?? 0)}
          />
        </div>
      </div>

      {/* ---------------- Revenue trend with a peak callout ---------------- */}
      <Card className="glass mt-6 rounded-2xl p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <TrendingUp className="h-4 w-4 text-primary" /> Revenue trend
          </h3>
          {summary?.forecast_next_month !== undefined && (
            <span className="text-xs text-muted-foreground">Next month forecast: <b className="text-primary">{money(summary.forecast_next_month)}</b></span>
          )}
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={revenueSeries} margin={{ top: 30, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.32 0.06 290 / 25%)" vertical={false} />
            <XAxis dataKey="month" stroke={axisColor} fontSize={12} tickLine={false} axisLine={false} />
            <YAxis stroke={axisColor} fontSize={12} tickFormatter={(v) => money(v)} width={80} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => money(v)} />
            <Line type="monotone" dataKey="revenue" name="Won revenue" stroke={PALETTE[0]} strokeWidth={3} dot={{ r: 3, fill: PALETTE[0] }} activeDot={{ r: 5 }} />
            {peakMonth && (
              <ReferenceDot
                x={peakMonth.month}
                y={peakMonth.revenue}
                r={5}
                fill={PALETTE[0]}
                stroke="white"
                strokeWidth={2}
                label={{ value: `Max ${money(peakMonth.revenue)}`, position: "top", fill: "oklch(0.92 0.02 290)", fontSize: 11 }}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </Card>

      {/* ---------------- Donuts: pipeline value + lead sources ---------------- */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card className="glass rounded-2xl p-6">
          <h3 className="mb-4 text-base font-semibold">Pipeline value by stage</h3>
          <SideLegendDonut
            data={stageValuePie}
            centerLabel="Deals"
            onSliceClick={(stage) => openOpportunitiesDrill(stage, `${opportunities.filter((o: any) => o.stage === stage).length} deals`, opportunities.filter((o: any) => o.stage === stage))}
          />
        </Card>

        <Card className="glass rounded-2xl p-6">
          <h3 className="mb-4 text-base font-semibold">Lead sources</h3>
          <SideLegendDonut
            data={sourcePie}
            centerLabel="Leads"
            onSliceClick={(source) => openLeadsDrill(source, `Leads sourced from ${source}`, leads.filter((l: any) => (l.source || "Unknown") === source))}
          />
        </Card>
      </div>

      {/* ---------------- Opportunities bar + funnel bar ---------------- */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card className="glass rounded-2xl p-6">
          <h3 className="mb-4 text-base font-semibold">Opportunities by stage</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart
              data={byStage}
              onClick={(e) => {
                const point = e?.activePayload?.[0]?.payload as { stage: string } | undefined;
                if (point) openOpportunitiesDrill(point.stage, `${opportunities.filter((o: any) => o.stage === point.stage).length} deals`, opportunities.filter((o: any) => o.stage === point.stage));
              }}
            >
              <defs>
                <linearGradient id="stageBarGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={PALETTE[1]} stopOpacity={1} />
                  <stop offset="100%" stopColor={PALETTE[0]} stopOpacity={0.6} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.32 0.06 290 / 25%)" vertical={false} />
              <XAxis dataKey="stage" stroke={axisColor} fontSize={11} interval={0} angle={-15} textAnchor="end" height={60} tickLine={false} axisLine={false} />
              <YAxis stroke={axisColor} fontSize={12} allowDecimals={false} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "oklch(0.32 0.06 290 / 15%)" }} />
              <Bar dataKey="count" fill="url(#stageBarGrad)" radius={[8, 8, 0, 0]} cursor="pointer" maxBarSize={44} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card className="glass rounded-2xl p-6">
          <h3 className="mb-4 text-base font-semibold">Lead status funnel</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart
              layout="vertical"
              data={summary?.funnel ?? []}
              margin={{ left: 24 }}
              onClick={(e) => {
                const point = e?.activePayload?.[0]?.payload as { stage: string; label: string; count: number } | undefined;
                if (point) openLeadsDrill(point.label, `${point.count} leads`, leads.filter((l: any) => l.status === point.stage));
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.32 0.06 290 / 25%)" horizontal={false} />
              <XAxis type="number" stroke={axisColor} fontSize={12} allowDecimals={false} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey="label" stroke={axisColor} fontSize={12} width={100} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "oklch(0.32 0.06 290 / 15%)" }} />
              <Bar dataKey="count" radius={[0, 8, 8, 0]} cursor="pointer" maxBarSize={22}>
                {(summary?.funnel ?? []).map((_: any, i: number) => <Cell key={i} fill={PALETTE[(i + 3) % PALETTE.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* ---------------- Top customers + notifications ---------------- */}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="glass rounded-2xl p-6 lg:col-span-2">
          <h3 className="mb-4 text-base font-semibold">Top customers by revenue</h3>
          {!summary?.top_customers?.length ? (
            <p className="text-sm text-muted-foreground">No won revenue recorded for this period yet.</p>
          ) : (
            <div className="space-y-2">
              {summary.top_customers.map((c: any, i: number) => {
                const max = summary.top_customers[0]?.revenue || 1;
                const pct = Math.max(6, Math.round((c.revenue / max) * 100));
                return (
                  <button
                    key={c.name}
                    onClick={() => openOpportunitiesDrill(c.name, `${money(c.revenue)} in won revenue`, opportunities.filter((o: any) => o.customer_name === c.name))}
                    className="group flex w-full items-center gap-3 rounded-xl p-1.5 text-left transition-colors hover:bg-muted/40"
                  >
                    <span className="w-32 shrink-0 truncate text-sm">{c.name}</span>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full transition-all duration-500 group-hover:brightness-110"
                        style={{ width: `${pct}%`, background: PALETTE[i % PALETTE.length] }}
                      />
                    </div>
                    <span className="w-24 shrink-0 text-right text-sm font-medium">{money(c.revenue)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <Card className="glass rounded-2xl p-6">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-base font-semibold">
              <Bell className="h-4 w-4 text-primary" /> Notifications
            </h3>
            {!!extra?.notifSummary?.unread && (
              <button
                onClick={() => setDrill({
                  title: "Unread notifications", subtitle: `${extra.notifSummary.unread} unread`, totalCount: extra.notifUnread.length,
                  items: extra.notifUnread.map((n: any) => ({
                    label: n.title || n.type,
                    value: n.created_at ? new Date(n.created_at).toLocaleDateString("en-IN") : undefined,
                    meta: n.message,
                  })),
                })}
                className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary hover:bg-primary/20"
              >
                {extra.notifSummary.unread} new
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl border p-3">
              <div className="text-muted-foreground">Today</div>
              <div className="text-xl font-semibold">{extra?.notifSummary?.today ?? "—"}</div>
            </div>
            <div className="rounded-xl border p-3">
              <div className="text-muted-foreground">Total</div>
              <div className="text-xl font-semibold">{extra?.notifSummary?.total ?? "—"}</div>
            </div>
          </div>
        </Card>
      </div>

      {/* ---------------- Communications + product catalog ---------------- */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card className="glass rounded-2xl p-6">
          <h3 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <MessageSquare className="h-4 w-4 text-primary" /> Communications by type
          </h3>
          <div className="mb-4 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl border p-3"><div className="text-muted-foreground">This week</div><div className="text-xl font-semibold">{extra?.comms?.this_week ?? "—"}</div></div>
            <div className="rounded-xl border p-3"><div className="text-muted-foreground">Overdue follow-ups</div><div className="text-xl font-semibold">{extra?.comms?.overdue_followups ?? "—"}</div></div>
          </div>
          <SideLegendDonut data={commsPie} centerLabel="Logged" />
        </Card>

        <Card className="glass rounded-2xl p-6">
          <h3 className="mb-4 flex items-center gap-2 text-base font-semibold">
            <Package className="h-4 w-4 text-primary" /> Product catalog
          </h3>
          <div className="mb-4 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl border p-3"><div className="text-muted-foreground">Catalog value</div><div className="text-lg font-semibold">{extra?.products ? money(Number(extra.products.catalog_value)) : "—"}</div></div>
            <div className="rounded-xl border p-3"><div className="text-muted-foreground">Avg price</div><div className="text-lg font-semibold">{extra?.products ? money(Number(extra.products.avg_price)) : "—"}</div></div>
          </div>
          <SideLegendDonut data={productsPie} centerLabel="Products" />
        </Card>
      </div>

      <DrillDialog drill={drill} onClose={closeDrill} />
    </div>
  );
}
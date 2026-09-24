import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  LineChart, Line,
} from "recharts";
import {
  RefreshCw, Download, Activity, Eye, MousePointerClick, MessageCircle, Globe,
  MapPin, Clock, Users, Send, AlertTriangle, ExternalLink,
} from "lucide-react";

import { getAuthToken } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics — OrbitAvanya CRM" },
      { name: "description", content: "Real-time email tracking dashboard." },
    ],
  }),
  component: AnalyticsPage,
});

/* ---------------- Layout header (matches AI LLM / Tender Customers pages) ---------------- */

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

/* ---------------- Types (match emailtrackingserver.js's real response shape) ---------------- */

type Lead = Record<string, string | number | null>;

interface TrackingSummary {
  total: number; sent: number; bounced: number; opened: number;
  clicked: number; replied: number; visited: number;
  openRate: number; clickRate: number; replyRate: number; bounceRate: number;
}

interface LiveData {
  data: Lead[];
  summary: TrackingSummary;
  timeseries: { date: string; Sent: number; Opens: number; Clicks: number; Bounces: number; label: string }[];
  columns: string[];
  meta: {
    tracker_exists: boolean;
    tracker_file: string;
    tracker_modified_at: string | null;
  };
}

const KPI_STYLES: Record<string, { bg: string; text: string; icon: typeof Activity }> = {
  "Total Leads": { bg: "bg-indigo-50", text: "text-indigo-600", icon: Users },
  "Emails Sent": { bg: "bg-blue-50", text: "text-blue-600", icon: Send },
  "Emails Bounced": { bg: "bg-rose-50", text: "text-rose-600", icon: AlertTriangle },
  "Opened": { bg: "bg-emerald-50", text: "text-emerald-600", icon: Eye },
  "Clicked": { bg: "bg-amber-50", text: "text-amber-600", icon: MousePointerClick },
  "Replied": { bg: "bg-green-50", text: "text-green-600", icon: MessageCircle },
  "Website Visits": { bg: "bg-purple-50", text: "text-purple-600", icon: Globe },
};

// Every request on this page tries the relative path first (works when a
// dev-server proxy is configured), then falls back to the backend's direct
// port — same fix already applied on the AI LLM page's download button, so
// this never silently does nothing if the proxy isn't set up.
async function fetchWithFallback(path: string, init?: RequestInit): Promise<Response> {
  const candidates = [path, `http://localhost:5000${path}`];
  let lastErr: any = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, init);
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("html")) {
        // Hit a frontend dev-server fallback page, not the real backend.
        lastErr = new Error(`${url} did not reach the backend.`);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Could not reach the backend.");
}

function AnalyticsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [summary, setSummary] = useState<TrackingSummary | null>(null);
  const [timeseries, setTimeseries] = useState<LiveData["timeseries"]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [trackerReady, setTrackerReady] = useState<boolean | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLive = async (showStatus = false) => {
    try {
      const token = getAuthToken();
      const res = await fetchWithFallback("/api/email-tracking/live", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `Server error (${res.status})`);
      }
      const live: LiveData = await res.json();
      setLeads(live.data);
      setSummary(live.summary);
      setTimeseries(live.timeseries);
      setColumns(live.columns || (live.data.length > 0 ? Object.keys(live.data[0]) : []));
      setTrackerReady(live.meta?.tracker_exists ?? null);
      if (showStatus) setLastSync(new Date().toLocaleTimeString());
      setError(null);
    } catch (e) {
      if (showStatus) setError(e instanceof Error ? e.message : "Could not sync — server unreachable.");
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    await fetchLive(true);
    setSyncing(false);
  };

  useEffect(() => {
    fetchLive(true);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (autoRefresh) {
      intervalRef.current = setInterval(() => fetchLive(false), 15000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh]);

  const downloadExcel = async () => {
    try {
      const token = getAuthToken();
      const res = await fetchWithFallback("/api/email-tracking/excel", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || "Email tracking workbook not found.");
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "Email_Tracking_NEW.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message || "Download failed.");
    }
  };

  const numericCols = columns.filter(c =>
    c !== "Company" && c !== "Contact Person" && c !== "Email" && c !== "Subject" &&
    c !== "Sent Date" && c !== "Email Sent In Language" && c !== "Email Open Status" &&
    c !== "Link Clicked" && c !== "Email Send Status" && c !== "Reply Received" &&
    c !== "Send Error" && c !== "Reply Subject" && c !== "Last Visit At" &&
    c !== "Email Opened At" && c !== "Link Clicked At" && c !== "Reply Date" &&
    c !== "Reminder Due" && c !== "Opened From Country" && c !== "Opened From City" &&
    c !== "Opened Timezone"
  );

  const chartKeys = timeseries.length > 0
    ? ["Sent", "Opens", "Clicks", "Bounces"]
    : numericCols.slice(0, 4);

  void chartKeys;

  const openedLeads = leads.filter(r => String(r["Email Open Status"]).trim() === "Opened");
  const clickedLeads = leads.filter(r => String(r["Link Clicked"]).trim() === "Yes");

  return (
    <div>
      <LocalPageHeader
        title="Tracking Analytics"
        description="Real-time email tracking dashboard — opens, clicks, replies, and website visits from every proposal email you've sent."
        icon={Activity}
        actions={
          <div className="flex flex-wrap gap-2">
            <button
              onClick={syncNow}
              disabled={syncing}
              className="inline-flex items-center gap-2 rounded-md bg-indigo-600 text-white text-sm font-medium px-4 py-2.5 hover:bg-indigo-700 disabled:opacity-50"
            >
              <RefreshCw className={`size-4 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Syncing..." : "Sync Now"}
            </button>
            <button
              onClick={downloadExcel}
              className="inline-flex items-center gap-2 rounded-md bg-emerald-600 text-white text-sm font-medium px-4 py-2.5 hover:bg-emerald-700"
            >
              <Download className="size-4" />
              Download Excel
            </button>
          </div>
        }
      />

      <div className="mx-auto max-w-[1600px] space-y-4 px-6 py-6">
        {error && (
          <div className="flex items-start gap-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
            <AlertTriangle className="size-4 mt-0.5 shrink-0" />
            <div>
              {error}
              {trackerReady === false && (
                <p className="mt-1 text-xs text-rose-600">
                  Check <code>EMAIL_AUTOMATION_DATA_DIR</code> in your backend's <code>.env</code> — it should
                  point to the folder containing <code>Email_Tracking_NEW.xlsx</code>.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4 text-xs text-slate-500">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded"
              />
              Auto-refresh (15s)
            </label>
            {trackerReady !== null && (
              <span className={`flex items-center gap-1 ${trackerReady ? "text-emerald-600" : "text-slate-400"}`}>
                <span className={`size-1.5 rounded-full ${trackerReady ? "bg-emerald-500" : "bg-slate-300"}`} />
                {trackerReady ? "Tracking workbook connected" : "Tracking workbook not found"}
              </span>
            )}
            {lastSync && <span>Last sync: {lastSync}</span>}
            {leads.length > 0 && <span>{leads.length} leads</span>}
          </div>
        </div>

        {summary && (
          <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
            {Object.entries(KPI_STYLES).map(([label, style]) => {
              const value = label === "Total Leads" ? summary.total
                : label === "Emails Sent" ? summary.sent
                : label === "Emails Bounced" ? summary.bounced
                : label === "Opened" ? `${summary.opened} (${summary.openRate}%)`
                : label === "Clicked" ? `${summary.clicked} (${summary.clickRate}%)`
                : label === "Replied" ? summary.replied
                : label === "Website Visits" ? summary.visited : "—";
              const Icon = style.icon;
              return (
                <div key={label} className={`rounded-xl ${style.bg} border border-slate-200 shadow-sm p-3`}>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className={`size-3.5 ${style.text}`} />
                    <span className="text-[10px] text-slate-500 uppercase tracking-wide font-medium">{label}</span>
                  </div>
                  <div className={`text-lg font-bold ${style.text}`}>{value}</div>
                </div>
              );
            })}
          </section>
        )}

        {timeseries.length > 0 && (
          <section className="grid lg:grid-cols-2 gap-6">
            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-3">
                <Activity className="size-4 text-slate-400" />
                <h3 className="font-semibold text-sm">Sent / Opens / Clicks / Bounces over time</h3>
              </div>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={timeseries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="Sent" fill="#6366f1" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Opens" fill="#10b981" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Clicks" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Bounces" fill="#ef4444" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-5">
              <div className="flex items-center gap-2 mb-3">
                <Eye className="size-4 text-slate-400" />
                <h3 className="font-semibold text-sm">Open rate trend</h3>
              </div>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={timeseries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="Opens" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} name="Opens" />
                    <Line type="monotone" dataKey="Clicks" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} name="Clicks" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </section>
        )}

        {leads.length > 0 && (
          <>
            <section className="rounded-xl bg-white border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <Eye className="size-4 text-emerald-500" />
                  Who Opened ({openedLeads.length})
                </h3>
              </div>
              <div className="overflow-auto max-h-60">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Company</th>
                      <th className="text-left px-3 py-2 font-medium">Contact</th>
                      <th className="text-left px-3 py-2 font-medium">Email</th>
                      <th className="text-left px-3 py-2 font-medium">Opened At</th>
                      <th className="text-left px-3 py-2 font-medium">Count</th>
                      <th className="text-left px-3 py-2 font-medium">Location</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {openedLeads.slice(0, 50).map((r, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-3 py-2 font-medium">{r.Company || "—"}</td>
                        <td className="px-3 py-2">{r["Contact Person"] || "—"}</td>
                        <td className="px-3 py-2 text-xs text-slate-500">{r.Email || "—"}</td>
                        <td className="px-3 py-2">{r["Email Opened At"] || "—"}</td>
                        <td className="px-3 py-2">{r["Email Open Count"] || 0}</td>
                        <td className="px-3 py-2 text-xs">
                          {r["Opened From City"] && r["Opened From City"] !== "—" ? (
                            <span className="flex items-center gap-1">
                              <MapPin className="size-3 text-slate-400" />
                              {r["Opened From City"]}, {r["Opened From Country"]}
                              {r["Opened Timezone"] && r["Opened Timezone"] !== "—" && (
                                <span className="text-slate-400 ml-1">({r["Opened Timezone"]})</span>
                              )}
                            </span>
                          ) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-xl bg-white border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <MousePointerClick className="size-4 text-amber-500" />
                  Who Clicked ({clickedLeads.length})
                </h3>
              </div>
              <div className="overflow-auto max-h-60">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Company</th>
                      <th className="text-left px-3 py-2 font-medium">Clicked At</th>
                      <th className="text-left px-3 py-2 font-medium">Count</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {clickedLeads.slice(0, 50).map((r, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-3 py-2 font-medium">{r.Company || "—"}</td>
                        <td className="px-3 py-2">{r["Link Clicked At"] || "—"}</td>
                        <td className="px-3 py-2">{r["Link Click Count"] || 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-xl bg-white border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <Globe className="size-4 text-purple-500" />
                  Website Visits
                </h3>
              </div>
              <div className="overflow-auto max-h-60">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Company</th>
                      <th className="text-left px-3 py-2 font-medium">Visits</th>
                      <th className="text-left px-3 py-2 font-medium">Total Time</th>
                      <th className="text-left px-3 py-2 font-medium">Last Visit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {leads.filter(r => Number(r["Website Visits"]) > 0).slice(0, 50).map((r, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-3 py-2 font-medium">{r.Company || "—"}</td>
                        <td className="px-3 py-2">{r["Website Visits"] || 0}</td>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-1">
                            <Clock className="size-3 text-slate-400" />
                            {r["Total Time on Website"] || "0 sec"}
                          </span>
                        </td>
                        <td className="px-3 py-2">{r["Last Visit At"] || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-xl bg-white border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <ExternalLink className="size-4 text-slate-500" />
                  All Leads — Full Tracking Data ({leads.length})
                </h3>
              </div>
              <div className="overflow-auto max-h-96">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide sticky top-0">
                    <tr>
                      {columns.map(c => (
                        <th key={c} className="text-left px-3 py-2 font-medium whitespace-nowrap">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {leads.slice(0, 200).map((r, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        {columns.map(c => {
                          const val = r[c];
                          const isOpen = c === "Email Open Status" && String(val).trim() === "Opened";
                          const isClick = c === "Link Clicked" && String(val).trim() === "Yes";
                          const isReply = c === "Reply Received" && String(val).trim() === "Yes";
                          const isBounce = c === "Email Send Status" && String(val).trim() === "Bounced";
                          const isSent = c === "Email Send Status" && String(val).trim() === "Sent";
                          return (
                            <td key={c} className="px-3 py-2 whitespace-nowrap text-xs">
                              {isOpen ? <span className="text-emerald-600 font-medium">✓ Opened</span>
                                : isClick ? <span className="text-amber-600 font-medium">✓ Clicked</span>
                                : isReply ? <span className="text-green-600 font-medium">✓ Replied</span>
                                : isBounce ? <span className="text-rose-600 font-medium">⚠ Bounced</span>
                                : isSent ? <span className="text-blue-600 font-medium">Sent</span>
                                : val === null || val === undefined || val === "—"
                                  ? <span className="text-slate-300">—</span>
                                  : String(val)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {!leads.length && !syncing && !error && (
          <div className="text-center py-20 text-slate-400">
            <Activity className="size-12 mx-auto mb-4 opacity-50" />
            <p className="text-lg font-medium mb-1">No tracking data yet</p>
            <p className="text-sm">Send a proposal email or click Sync Now.</p>
          </div>
        )}
      </div>
    </div>
  );
}
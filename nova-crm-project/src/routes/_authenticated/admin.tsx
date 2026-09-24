import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/auth";
import { PageHeader } from "@/components/PageBits";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Settings,
  Users,
  FileText,
  Sparkles,
  Activity,
  AlertTriangle,
  Database,
  Mail,
  Server,
  RefreshCw,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { title: "Admin — OrbitAvanya CRM" },
      { name: "description", content: "Users, system health, runtime errors, and CRM diagnostics." },
    ],
  }),
  component: Admin,
});


function Admin() {
  const { data: user } = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const data = await api("/api/auth/me");
      const u = data.user;
      if (!u) return null;
      const result = {
        id: u.id,
        email: u.email || "",
        profile: { full_name: u.full_name || "" },
        roles: u.role ? [u.role] : [],
      };

      // Record the signed-in session for the Admin "who is active" view.
      if (result.email) {
        void api("/api/admin/session", {
          method: "POST",
          body: JSON.stringify({
            email: result.email,
            name: result.profile?.full_name || null,
            role: result.roles[0] || null,
          }),
        }).catch(() => {});
      }

      return result;
    },
    staleTime: 60_000,
  });

  const { data: health, isFetching: healthFetching, refetch: refetchHealth } = useQuery({
    queryKey: ["admin-health"],
    queryFn: () => api("/api/admin/health"),
    refetchInterval: 15_000,
  });

  const { data: logs = [], refetch: refetchLogs } = useQuery({
    queryKey: ["admin-logs"],
    queryFn: () => api("/api/admin/logs?limit=150"),
    refetchInterval: 10_000,
  });

  const { data: sessions = [], refetch: refetchSessions } = useQuery({
    queryKey: ["admin-login-activity"],
    queryFn: () => api("/api/admin/login-activity"),
    refetchInterval: 15_000,
  });

  const errorLogs = logs.filter((l: any) => String(l.level).toUpperCase() === "ERROR");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin Panel"
        description="Monitor signed-in sessions, backend health, runtime errors, email services, and CRM activity."
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="glass p-6">
          <div className="mb-3 flex items-center gap-2">
            <Users className="h-4 w-4 text-accent" />
            <h3 className="font-semibold">Current account</h3>
          </div>
          <div className="space-y-1 text-sm">
            <div><span className="text-muted-foreground">Name: </span>{user?.profile?.full_name ?? "—"}</div>
            <div><span className="text-muted-foreground">Email: </span>{user?.email || "—"}</div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Roles:</span>
              {user?.roles?.length
                ? user.roles.map((r: string) => <Badge key={r} variant="secondary">{r}</Badge>)
                : <Badge variant="outline">No role</Badge>}
            </div>
          </div>
        </Card>

        <Card className="glass p-6">
          <div className="mb-3 flex items-center gap-2">
            <Server className="h-4 w-4 text-accent" />
            <h3 className="font-semibold">System health</h3>
            <Badge variant={health?.ok ? "default" : "destructive"}>
              {health?.ok ? "Healthy" : "Problem"}
            </Badge>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-muted-foreground">Database: </span>{health?.database || "Checking…"}</div>
            <div><span className="text-muted-foreground">Uptime: </span>{health ? `${health.uptime_seconds}s` : "—"}</div>
            <div><span className="text-muted-foreground">Email send: </span>{health?.email_send ? "Enabled" : "Disabled"}</div>
            <div><span className="text-muted-foreground">Email receive: </span>{health?.email_receive ? "Enabled" : "Disabled"}</div>
            <div><span className="text-muted-foreground">Leads: </span>{health?.leads ?? "—"}</div>
            <div><span className="text-muted-foreground">Pipeline: </span>{health?.opportunities ?? "—"}</div>
          </div>
          <button
            className="mt-4 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
            onClick={() => refetchHealth()}
          >
            <RefreshCw className={healthFetching ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            Refresh health
          </button>
        </Card>
      </div>

      <Card className="glass p-6">
        <div className="mb-4 flex items-center gap-2">
          <Activity className="h-4 w-4 text-accent" />
          <h3 className="font-semibold">Recent signed-in sessions</h3>
          <Badge variant="secondary">{sessions.length}</Badge>
        </div>
        <div className="max-h-72 overflow-auto space-y-2">
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No session activity has been recorded yet.</p>
          ) : sessions.map((s: any) => (
            <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3 text-sm">
              <Users className="h-4 w-4 text-muted-foreground" />
              <div className="min-w-[180px] flex-1">
                <div className="font-medium">{s.name || s.email}</div>
                <div className="text-xs text-muted-foreground">{s.email} · {s.role || "user"}</div>
              </div>
              <Badge variant="outline">{s.event_type}</Badge>
              <div className="text-xs text-muted-foreground">{s.created_at ? new Date(s.created_at).toLocaleString("en-IN") : "—"}</div>
            </div>
          ))}
        </div>
        <button className="mt-4 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs" onClick={() => refetchSessions()}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh sessions
        </button>
      </Card>

      <Card className="glass p-6">
        <div className="mb-4 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <h3 className="font-semibold">Errors / problems</h3>
          <Badge variant={errorLogs.length ? "destructive" : "default"}>{errorLogs.length}</Badge>
        </div>
        <div className="max-h-80 overflow-auto space-y-2">
          {errorLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runtime errors recorded.</p>
          ) : errorLogs.map((log: any, index: number) => (
            <div key={`${log.time}-${index}`} className="rounded-md border border-red-400/30 bg-red-500/5 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="destructive">{log.level}</Badge>
                <span className="text-muted-foreground">{log.time ? new Date(log.time).toLocaleString("en-IN") : "—"}</span>
              </div>
              <div className="mt-1 text-sm font-medium">{log.message}</div>
              {log.meta?.stack && <pre className="mt-2 overflow-auto text-xs text-muted-foreground">{log.meta.stack}</pre>}
            </div>
          ))}
        </div>
        <button className="mt-4 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs" onClick={() => refetchLogs()}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh errors
        </button>
      </Card>

      <Card className="glass p-6">
        <div className="mb-3 flex items-center gap-2"><Database className="h-4 w-4 text-accent" /><h3 className="font-semibold">CRM counters</h3></div>
        <div className="grid gap-3 md:grid-cols-4 text-sm">
          <div className="rounded-md border p-3"><div className="text-muted-foreground">Customers</div><div className="text-xl font-semibold">{health?.customers ?? "—"}</div></div>
          <div className="rounded-md border p-3"><div className="text-muted-foreground">Communications</div><div className="text-xl font-semibold">{health?.communications ?? "—"}</div></div>
          <div className="rounded-md border p-3"><div className="text-muted-foreground">Unread notifications</div><div className="text-xl font-semibold">{health?.unread_notifications ?? "—"}</div></div>
          <div className="rounded-md border p-3"><div className="text-muted-foreground">Currency</div><div className="text-xl font-semibold">INR ₹</div></div>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="glass p-6">
          <div className="mb-3 flex items-center gap-2"><Mail className="h-4 w-4 text-accent" /><h3 className="font-semibold">Email automation</h3></div>
          <p className="text-sm text-muted-foreground">
            Incoming emails create a communication, lead, and Prospecting opportunity automatically. The value is read from
            ₹/INR budget text, converted from $, or estimated from the pricing catalog.
          </p>
        </Card>
        <Card className="glass p-6">
          <div className="mb-3 flex items-center gap-2"><Sparkles className="h-4 w-4 text-accent" /><h3 className="font-semibold">AI Configuration</h3></div>
          <p className="text-sm text-muted-foreground">AI lead scoring and proposal generation remain on the existing backend configuration.</p>
        </Card>
      </div>

      <Card className="glass p-6">
        <div className="mb-3 flex items-center gap-2"><FileText className="h-4 w-4 text-accent" /><h3 className="font-semibold">Deployment note</h3></div>
        <p className="text-sm text-muted-foreground">
          The Express backend must remain running on cPanel (Passenger/Node.js app or the host's Node process manager).
          Set the frontend API base to the public backend URL or proxy /api to the backend.
        </p>
        <div className="mt-3 rounded-md border p-3 text-xs">
          <strong>Diagnostics:</strong> server runtime logs are written to <code>logs/crm-runtime.log</code>.
        </div>
      </Card>
    </div>
  );
}

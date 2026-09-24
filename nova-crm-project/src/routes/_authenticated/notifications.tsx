import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { PageHeader, EmptyState, StatCard } from "@/components/PageBits";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Bell, Check, CheckCheck, Trash2, Trophy, XCircle, FileCheck2, FileX2, Send, Info, Clock,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/notifications")({
  head: () => ({ meta: [{ title: "Notifications — Nova CRM" }, { name: "description", content: "Alerts and reminders." }] }),
  component: Notifications,
});

type NotificationSummary = {
  total: number;
  unread: number;
  today: number;
  by_type: { type: string; count: number }[];
};

const TYPE_META: Record<string, { label: string; icon: any; className: string }> = {
  deal_won: { label: "Deal won", icon: Trophy, className: "bg-emerald-500" },
  deal_lost: { label: "Deal lost", icon: XCircle, className: "bg-rose-500" },
  proposal_approved: { label: "Proposal approved", icon: FileCheck2, className: "bg-emerald-500" },
  proposal_rejected: { label: "Proposal rejected", icon: FileX2, className: "bg-rose-500" },
  proposal_sent: { label: "Proposal sent", icon: Send, className: "bg-sky-500" },
  reminder: { label: "Follow-up", icon: Clock, className: "bg-amber-500" },
  info: { label: "Info", icon: Info, className: "bg-gradient-primary" },
};

function metaFor(type: string | null) {
  return TYPE_META[type ?? "info"] ?? TYPE_META.info;
}

function Notifications() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"all" | "unread">("all");

  // Turn due/overdue follow-ups into notifications through the PostgreSQL API.
  const syncFollowups = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/communications/sync-reminders", { method: "POST" });
      if (!response.ok) throw new Error("Failed to sync reminders.");
      return (await response.json()).count as number;
    },
    onSuccess: (count) => {
      if (count > 0) {
        qc.invalidateQueries({ queryKey: ["notifications"] });
        qc.invalidateQueries({ queryKey: ["notifications-summary"] });
      }
    },
  });


  useEffect(() => { syncFollowups.mutate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => {
      const response = await fetch("/api/notifications");
      if (!response.ok) throw new Error("Failed to load notifications.");
      return (await response.json()) ?? [];
    },
    refetchInterval: 15000,
  });

  const { data: summary } = useQuery({
    queryKey: ["notifications-summary"],
    queryFn: async () => {
      const response = await fetch("/api/notifications/summary");
      if (!response.ok) throw new Error("Failed to load notification summary.");
      return (await response.json()) as NotificationSummary;
    },
    refetchInterval: 15000,
  });

  const markRead = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/notifications/${id}/read`, { method: "PUT" });
      if (!response.ok) throw new Error("Failed to mark notification as read.");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["notifications-summary"] });
    },
  });

  const markAllRead = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/notifications/read-all", { method: "PUT" });
      if (!response.ok) throw new Error("Failed to mark notifications as read.");
      return (await response.json()).count as number;
    },
    onSuccess: (count) => {
      toast.success(count > 0 ? `Marked ${count} notification${count === 1 ? "" : "s"} as read` : "Nothing to mark read");
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["notifications-summary"] });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/notifications/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to delete notification.");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["notifications-summary"] });
    },
  });

  const visible = useMemo(
    () => (tab === "unread" ? items.filter((n: any) => !n.read) : items),
    [items, tab],
  );

  function openNotification(n: any) {
    if (!n.read) markRead.mutate(n.id);
    if (n.link) navigate({ to: n.link });
  }

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Follow-up reminders, approvals, and deal updates."
        actions={
          <Button size="sm" variant="outline" disabled={!summary?.unread} onClick={() => markAllRead.mutate()}>
            <CheckCheck className="mr-2 h-4 w-4" /> Mark all read
          </Button>
        }
      />

      {summary && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="Total" value={summary.total} />
          <StatCard label="Unread" value={summary.unread} />
          <StatCard label="Today" value={summary.today} />
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as "all" | "unread")} className="mb-4">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="unread">
            Unread{summary?.unread ? ` (${summary.unread})` : ""}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="grid gap-2">
          {[...Array(3)].map((_, i) => <div key={i} className="glass h-20 animate-pulse rounded-2xl" />)}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          title={tab === "unread" ? "No unread notifications" : "You're all caught up"}
          description="Notifications will appear here when there's activity."
        />
      ) : (
        <div className="grid gap-2">
          {visible.map((n: any) => {
            const meta = metaFor(n.type);
            const Icon = meta.icon;
            return (
              <Card
                key={n.id}
                className={`glass flex items-start gap-3 p-4 transition-opacity ${n.read ? "opacity-60" : ""} ${n.link ? "cursor-pointer hover:opacity-90" : ""}`}
                onClick={() => n.link && openNotification(n)}
              >
                <div className={`mt-1 rounded-lg p-2 shadow-glow ${meta.className}`}>
                  <Icon className="h-4 w-4 text-primary-foreground" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{n.title}</span>
                    {!n.read && <Badge variant="secondary" className="h-1.5 w-1.5 rounded-full p-0" />}
                  </div>
                  {n.message && <p className="text-sm text-muted-foreground">{n.message}</p>}
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{meta.label}</Badge>
                    <span>{new Date(n.created_at).toLocaleString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  {!n.read && (
                    <Button size="sm" variant="ghost" title="Mark as read" onClick={() => markRead.mutate(n.id)}>
                      <Check className="h-4 w-4" />
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" title="Delete" onClick={() => remove.mutate(n.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
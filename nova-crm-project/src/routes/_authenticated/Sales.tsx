import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader, EmptyState } from "@/components/PageBits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Plus, Sparkles, Trash2, ArrowRightCircle, CalendarClock, ListChecks, ShieldCheck, UserCheck, Mail } from "lucide-react";
import { money } from "@/lib/currency";

export const Route = createFileRoute("/_authenticated/Sales")({
  head: () => ({
    meta: [
      { title: "Leads & Pipeline — OrbitAvanya CRM" },
      { name: "description", content: "Track leads, score them with AI, and manage your sales pipeline." },
    ],
  }),
  component: LeadsAndPipeline,
});

/* ============================================================
   API helper
   The frontend (this page) and the Express backend (server.js)
   run on different ports/origins in dev (e.g. :8080 vs :5000),
   so a relative fetch("/api/...") resolves against the FRONTEND
   origin and 404s — there's nothing there. We prefix every call
   with the backend's base URL instead.
   Override by setting window.__NOVA_API_BASE__ before this page
   mounts (e.g. in production behind a reverse proxy that forwards
   /api to the backend, you can set this to "").
============================================================ */
const API_BASE =
  (typeof window !== "undefined" && (window as any).__NOVA_API_BASE__ !== undefined
    ? (window as any).__NOVA_API_BASE__
    : "http://localhost:5000");

async function api(path: string, options: RequestInit = {}) {
  const res = await fetch(API_BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json().catch(() => ({})) : null;
  if (!res.ok) {
    throw new Error((body && (body.message || body.error)) || `Request failed (${res.status})`);
  }
  return body;
}

const LEAD_STATUSES = ["new", "contacted", "qualified", "unqualified", "converted"];
const TASK_STATUSES = ["todo", "in_progress", "done"];
const TASK_PRIORITIES = ["low", "medium", "high"];
const APPROVAL_TYPES = ["discount", "contract", "proposal", "opportunity"];

function statusBadgeVariant(status: string) {
  if (status === "converted" || status === "Approved" || status === "done") return "default" as const;
  if (status === "unqualified" || status === "Rejected") return "destructive" as const;
  return "secondary" as const;
}

/* ============================================================
   Component
============================================================ */
function LeadsAndPipeline() {
  const qc = useQueryClient();

  /* ---------------- shared reference data ---------------- */
  const { data: customers = [] } = useQuery({
    queryKey: ["customers-mini"],
    queryFn: () => api("/api/customers"),
  });

  /* ---------------- email lead capture on/off ----------------
     Off  = keep showing existing leads exactly as they are, just stop
            pulling in new ones from the inbox.
     On   = resume capturing new (non-spam) inbox replies as leads. */
  const { data: emailCapture } = useQuery({
    queryKey: ["email-capture-status"],
    queryFn: () => api("/api/leads/email-capture"),
    refetchInterval: 30000,
  });

  const toggleEmailCapture = useMutation({
    mutationFn: (enabled: boolean) =>
      api("/api/leads/email-capture", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (data: { enabled: boolean }) => {
      toast.success(data.enabled ? "Email lead capture turned on" : "Email lead capture turned off");
      qc.invalidateQueries({ queryKey: ["email-capture-status"] });
      if (data.enabled) {
        // give the poller a moment to run, then refresh the leads list
        setTimeout(() => qc.invalidateQueries({ queryKey: ["leads"] }), 4000);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const purgeSpamLeads = useMutation({
    mutationFn: () => api("/api/leads/purge-spam", { method: "POST" }),
    onSuccess: (data: { deleted_leads: number }) => {
      toast.success(
        data.deleted_leads > 0
          ? `Removed ${data.deleted_leads} spam lead(s)`
          : "No spam leads found — nothing to remove"
      );
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ================= LEADS ================= */
  const [leadOpen, setLeadOpen] = useState(false);
  const [leadForm, setLeadForm] = useState({
    title: "",
    source: "",
    status: "new",
    estimated_value: "0",
    customer_id: "",
    notes: "",
  });
  const [assignDrafts, setAssignDrafts] = useState<Record<number, string>>({});

  const { data: leads = [] } = useQuery({
    queryKey: ["leads"],
    queryFn: () => api("/api/leads"),
  });

  const createLead = useMutation({
    mutationFn: () =>
      api("/api/leads", {
        method: "POST",
        body: JSON.stringify({
          ...leadForm,
          estimated_value: Number(leadForm.estimated_value) || 0,
          customer_id: leadForm.customer_id || null,
        }),
      }),
    onSuccess: () => {
      toast.success("Lead added");
      setLeadOpen(false);
      setLeadForm({ title: "", source: "", status: "new", estimated_value: "0", customer_id: "", notes: "" });
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteLead = useMutation({
    mutationFn: (id: number) => api(`/api/leads/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Removed");
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const scoreLead = useMutation({
    mutationFn: (id: number) => api(`/api/leads/${id}/score`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Lead scored");
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const assignLead = useMutation({
    mutationFn: ({ id, assigned_to }: { id: number; assigned_to: string }) =>
      api(`/api/leads/${id}/assign`, { method: "PUT", body: JSON.stringify({ assigned_to }) }),
    onSuccess: () => {
      toast.success("Lead assigned");
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const convertLead = useMutation({
    mutationFn: (id: number) => api(`/api/leads/${id}/convert`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Converted to opportunity");
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ================= PIPELINE: OPPORTUNITIES ================= */
  const [oppOpen, setOppOpen] = useState(false);
  const [oppForm, setOppForm] = useState({
    title: "",
    customer_id: "",
    stage: "Prospecting",
    value: "0",
    probability: "50",
    expected_close_date: "",
    owner: "",
    notes: "",
  });

  const { data: stages = [] } = useQuery({
    queryKey: ["pipeline-stages"],
    queryFn: () => api("/api/pipeline-stages"),
  });
  const { data: opportunities = [] } = useQuery({
    queryKey: ["opportunities"],
    queryFn: () => api("/api/opportunities"),
  });

  const createOpp = useMutation({
    mutationFn: () =>
      api("/api/opportunities", {
        method: "POST",
        body: JSON.stringify({
          ...oppForm,
          customer_id: oppForm.customer_id || null,
          value: Number(oppForm.value) || 0,
          probability: Number(oppForm.probability) || 0,
          expected_close_date: oppForm.expected_close_date || null,
        }),
      }),
    onSuccess: () => {
      toast.success("Opportunity added");
      setOppOpen(false);
      setOppForm({ title: "", customer_id: "", stage: "Prospecting", value: "0", probability: "50", expected_close_date: "", owner: "", notes: "" });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const moveStage = useMutation({
    mutationFn: ({ id, stage }: { id: number; stage: string }) =>
      api(`/api/opportunities/${id}/stage`, { method: "PUT", body: JSON.stringify({ stage }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["opportunities"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteOpp = useMutation({
    mutationFn: (id: number) => api(`/api/opportunities/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Removed");
      qc.invalidateQueries({ queryKey: ["opportunities"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ================= TASKS & ACTIVITIES ================= */
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskForm, setTaskForm] = useState({
    title: "",
    description: "",
    due_date: "",
    status: "todo",
    priority: "medium",
    assigned_to: "",
  });

  const { data: tasks = [] } = useQuery({
    queryKey: ["tasks"],
    queryFn: () => api("/api/tasks"),
  });

  const createTask = useMutation({
    mutationFn: () =>
      api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ ...taskForm, due_date: taskForm.due_date || null }),
      }),
    onSuccess: () => {
      toast.success("Task added");
      setTaskOpen(false);
      setTaskForm({ title: "", description: "", due_date: "", status: "todo", priority: "medium", assigned_to: "" });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cycleTaskStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api(`/api/tasks/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteTask = useMutation({
    mutationFn: (id: number) => api(`/api/tasks/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Removed");
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ================= CALENDAR ================= */
  const [eventOpen, setEventOpen] = useState(false);
  const [eventForm, setEventForm] = useState({ title: "", description: "", start_time: "", end_time: "" });

  const { data: events = [] } = useQuery({
    queryKey: ["calendar-events"],
    queryFn: () => api("/api/calendar-events"),
  });

  const createEvent = useMutation({
    mutationFn: () => api("/api/calendar-events", { method: "POST", body: JSON.stringify(eventForm) }),
    onSuccess: () => {
      toast.success("Event added");
      setEventOpen(false);
      setEventForm({ title: "", description: "", start_time: "", end_time: "" });
      qc.invalidateQueries({ queryKey: ["calendar-events"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteEvent = useMutation({
    mutationFn: (id: number) => api(`/api/calendar-events/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Removed");
      qc.invalidateQueries({ queryKey: ["calendar-events"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ================= APPROVAL WORKFLOW ================= */
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalForm, setApprovalForm] = useState({ type: "discount", requested_by: "", approver: "", notes: "" });

  const { data: approvals = [] } = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api("/api/approvals"),
  });

  const createApproval = useMutation({
    mutationFn: () => api("/api/approvals", { method: "POST", body: JSON.stringify(approvalForm) }),
    onSuccess: () => {
      toast.success("Approval requested");
      setApprovalOpen(false);
      setApprovalForm({ type: "discount", requested_by: "", approver: "", notes: "" });
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const decideApproval = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api(`/api/approvals/${id}/decision`, { method: "PUT", body: JSON.stringify({ status }) }),
    onSuccess: () => {
      toast.success("Updated");
      qc.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ================= SALES EMAIL ================= */
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailForm, setEmailForm] = useState({
    recipient_email: "",
    recipient_name: "",
    customer_id: "",
    lead_id: "",
    opportunity_id: "",
    subject: "",
    body: "",
  });

  const sendSalesEmail = useMutation({
    mutationFn: () =>
      api("/api/communications/send-email", {
        method: "POST",
        body: JSON.stringify({
          ...emailForm,
          customer_id: emailForm.customer_id || null,
          lead_id: emailForm.lead_id || null,
          opportunity_id: emailForm.opportunity_id || null,
        }),
      }),
    onSuccess: () => {
      toast.success("Email sent. Lead and pipeline were updated automatically.");
      setEmailOpen(false);
      setEmailForm({
        recipient_email: "",
        recipient_name: "",
        customer_id: "",
        lead_id: "",
        opportunity_id: "",
        subject: "",
        body: "",
      });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* ================= RENDER ================= */
  return (
    <div>
      <PageHeader title="Leads & Pipeline" description="Capture and score leads, then run them through your sales pipeline." />

      <Card className="mt-4 flex items-center justify-between gap-3 p-3">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <div>
            <div className="text-sm font-medium">Email lead capture</div>
            <div className="text-xs text-muted-foreground">
              {emailCapture?.enabled
                ? "On — new inbox replies (not spam/bounces) become leads automatically."
                : "Off — existing leads stay as they are; new inbox mail won't be captured."}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={emailCapture?.enabled ? "default" : "secondary"}>
            {emailCapture?.enabled ? "CAPTURING" : "STOPPED"}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            disabled={purgeSpamLeads.isPending}
            onClick={() => {
              if (window.confirm("Remove all leads/opportunities captured from known spam senders (avanyate@..., Cron)? This can't be undone.")) {
                purgeSpamLeads.mutate();
              }
            }}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Clean up spam
          </Button>
          <Button
            variant={emailCapture?.enabled ? "outline" : "default"}
            size="sm"
            disabled={toggleEmailCapture.isPending}
            onClick={() => toggleEmailCapture.mutate(!emailCapture?.enabled)}
          >
            {emailCapture?.enabled ? "Stop capture" : "Start capture"}
          </Button>
        </div>
      </Card>

      <Tabs defaultValue="leads" className="mt-4">
        <TabsList>
          <TabsTrigger value="leads">Leads</TabsTrigger>
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
        </TabsList>

        {/* ================= LEADS TAB ================= */}
        <TabsContent value="leads" className="mt-4">
          <div className="mb-4 flex justify-end">
            <Dialog open={leadOpen} onOpenChange={setLeadOpen}>
              <DialogTrigger asChild>
                <Button className="bg-gradient-primary shadow-glow">
                  <Plus className="mr-2 h-4 w-4" />
                  New lead
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New lead</DialogTitle>
                </DialogHeader>
                <div className="grid gap-3">
                  <div>
                    <Label>Title *</Label>
                    <Input value={leadForm.title} onChange={(e) => setLeadForm({ ...leadForm, title: e.target.value })} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Source</Label>
                      <Input value={leadForm.source} onChange={(e) => setLeadForm({ ...leadForm, source: e.target.value })} />
                    </div>
                    <div>
                      <Label>Status</Label>
                      <Select value={leadForm.status} onValueChange={(v) => setLeadForm({ ...leadForm, status: v })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LEAD_STATUSES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Estimated value (INR ₹)</Label>
                      <Input
                        type="number"
                        value={leadForm.estimated_value}
                        onChange={(e) => setLeadForm({ ...leadForm, estimated_value: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>Customer</Label>
                      <Select value={leadForm.customer_id} onValueChange={(v) => setLeadForm({ ...leadForm, customer_id: v })}>
                        <SelectTrigger>
                          <SelectValue placeholder="Optional" />
                        </SelectTrigger>
                        <SelectContent>
                          {customers.map((c: any) => (
                            <SelectItem key={c.id} value={String(c.id)}>
                              {c.company_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div>
                    <Label>Notes</Label>
                    <Textarea value={leadForm.notes} onChange={(e) => setLeadForm({ ...leadForm, notes: e.target.value })} />
                  </div>
                </div>
                <DialogFooter>
                  <Button onClick={() => createLead.mutate()} disabled={!leadForm.title || createLead.isPending} className="bg-gradient-primary shadow-glow">
                    Save
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Send sales email</DialogTitle>
                </DialogHeader>
                <div className="grid gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Recipient email *</Label>
                      <Input
                        value={emailForm.recipient_email}
                        onChange={(e) => setEmailForm({ ...emailForm, recipient_email: e.target.value })}
                        placeholder="customer@example.com"
                      />
                    </div>
                    <div>
                      <Label>Recipient name</Label>
                      <Input
                        value={emailForm.recipient_name}
                        onChange={(e) => setEmailForm({ ...emailForm, recipient_name: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Link to customer</Label>
                      <Select value={emailForm.customer_id} onValueChange={(v) => setEmailForm({ ...emailForm, customer_id: v })}>
                        <SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger>
                        <SelectContent>
                          {customers.map((c: any) => (
                            <SelectItem key={c.id} value={String(c.id)}>{c.company_name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Existing lead</Label>
                      <Select value={emailForm.lead_id} onValueChange={(v) => setEmailForm({ ...emailForm, lead_id: v })}>
                        <SelectTrigger><SelectValue placeholder="Auto-create if empty" /></SelectTrigger>
                        <SelectContent>
                          {leads.map((l: any) => (
                            <SelectItem key={l.id} value={String(l.id)}>{l.title}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div>
                    <Label>Subject *</Label>
                    <Input
                      value={emailForm.subject}
                      onChange={(e) => setEmailForm({ ...emailForm, subject: e.target.value })}
                      placeholder="CRM demo proposal"
                    />
                  </div>
                  <div>
                    <Label>Message *</Label>
                    <Textarea
                      rows={7}
                      value={emailForm.body}
                      onChange={(e) => setEmailForm({ ...emailForm, body: e.target.value })}
                      placeholder="Mention the project, budget, or service so the CRM can estimate the pipeline value."
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    No existing lead? The backend creates a new lead + Prospecting opportunity automatically.
                    ₹/INR amounts are stored as INR; $ amounts are converted using USD_TO_INR_RATE.
                  </p>
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => sendSalesEmail.mutate()}
                    disabled={
                      sendSalesEmail.isPending ||
                      !emailForm.recipient_email ||
                      !emailForm.subject ||
                      !emailForm.body
                    }
                    className="bg-gradient-primary shadow-glow"
                  >
                    <Mail className="mr-2 h-4 w-4" />
                    Send email
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {leads.length === 0 ? (
            <EmptyState title="No leads yet" description="Add a lead and let AI score it for you." />
          ) : (
            <div className="grid gap-3">
              {leads.map((l: any) => (
                <Card key={l.id} className="glass flex flex-wrap items-center gap-4 p-4">
                  <div className="flex-1 min-w-[220px]">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{l.title}</h3>
                      <Badge variant={statusBadgeVariant(l.status)}>{l.status}</Badge>
                      {l.customer_name && <span className="text-xs text-muted-foreground">· {l.customer_name}</span>}
                      {l.value_source && l.value_source !== "manual" && (
                        <Badge variant="outline" className="text-[10px]">Auto value</Badge>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {l.source ? `${l.source} · ` : ""}{money(l.estimated_value)}
                      {l.assigned_to ? ` · Assigned to ${l.assigned_to}` : ""}
                    </div>
                    {l.ai_insight && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        <Sparkles className="mr-1 inline h-3 w-3 text-accent" />
                        {l.ai_insight}
                      </p>
                    )}
                  </div>

                  <div className="text-right">
                    <div className="text-xs uppercase text-muted-foreground">AI Score</div>
                    <div className="text-2xl font-bold text-gradient">{l.score ?? "—"}</div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Input
                      placeholder="Assign to…"
                      className="h-9 w-32"
                      value={assignDrafts[l.id] ?? l.assigned_to ?? ""}
                      onChange={(e) => setAssignDrafts((d) => ({ ...d, [l.id]: e.target.value }))}
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      title="Assign"
                      onClick={() => assignLead.mutate({ id: l.id, assigned_to: assignDrafts[l.id] ?? l.assigned_to ?? "" })}
                      disabled={assignLead.isPending}
                    >
                      <UserCheck className="h-4 w-4" />
                    </Button>
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEmailForm({
                        recipient_email: l.customer_email || "",
                        recipient_name: l.customer_contact_name || "",
                        customer_id: l.customer_id ? String(l.customer_id) : "",
                        lead_id: String(l.id),
                        opportunity_id: l.opportunity_id ? String(l.opportunity_id) : "",
                        subject: l.title || "",
                        body: "",
                      });
                      setEmailOpen(true);
                    }}
                  >
                    <Mail className="mr-1 h-3.5 w-3.5" />
                    Email
                  </Button>

                  <Button variant="outline" size="sm" onClick={() => scoreLead.mutate(l.id)} disabled={scoreLead.isPending}>
                    <Sparkles className="mr-1 h-3.5 w-3.5" />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEmailForm({
                        recipient_email: l.customer_email || "",
                        recipient_name: l.customer_contact_name || "",
                        customer_id: l.customer_id ? String(l.customer_id) : "",
                        lead_id: String(l.id),
                        opportunity_id: l.opportunity_id ? String(l.opportunity_id) : "",
                        subject: l.title || "",
                        body: "",
                      });
                      setEmailOpen(true);
                    }}
                  >
                  </Button>


                    Score
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => convertLead.mutate(l.id)}
                    disabled={convertLead.isPending || l.status === "converted"}
                  >
                    <ArrowRightCircle className="mr-1 h-3.5 w-3.5" />
                    {l.status === "converted" ? "Converted" : "Convert"}
                  </Button>

                  <Button size="icon" variant="ghost" onClick={() => deleteLead.mutate(l.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ================= PIPELINE TAB ================= */}
        <TabsContent value="pipeline" className="mt-4 space-y-8">
          {/* --- Opportunities / Pipeline board --- */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Opportunity Pipeline</h2>
              <Dialog open={oppOpen} onOpenChange={setOppOpen}>
                <DialogTrigger asChild>
                  <Button className="bg-gradient-primary shadow-glow">
                    <Plus className="mr-2 h-4 w-4" />
                    New opportunity
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>New opportunity</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-3">
                    <div>
                      <Label>Title *</Label>
                      <Input value={oppForm.title} onChange={(e) => setOppForm({ ...oppForm, title: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Customer</Label>
                        <Select value={oppForm.customer_id} onValueChange={(v) => setOppForm({ ...oppForm, customer_id: v })}>
                          <SelectTrigger>
                            <SelectValue placeholder="Optional" />
                          </SelectTrigger>
                          <SelectContent>
                            {customers.map((c: any) => (
                              <SelectItem key={c.id} value={String(c.id)}>
                                {c.company_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>Stage</Label>
                        <Select value={oppForm.stage} onValueChange={(v) => setOppForm({ ...oppForm, stage: v })}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {stages.map((s: any) => (
                              <SelectItem key={s.id} value={s.name}>
                                {s.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <Label>Value (INR ₹)</Label>
                        <Input type="number" value={oppForm.value} onChange={(e) => setOppForm({ ...oppForm, value: e.target.value })} />
                      </div>
                      <div>
                        <Label>Probability (%)</Label>
                        <Input
                          type="number"
                          value={oppForm.probability}
                          onChange={(e) => setOppForm({ ...oppForm, probability: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label>Close date</Label>
                        <Input
                          type="date"
                          value={oppForm.expected_close_date}
                          onChange={(e) => setOppForm({ ...oppForm, expected_close_date: e.target.value })}
                        />
                      </div>
                    </div>
                    <div>
                      <Label>Owner</Label>
                      <Input value={oppForm.owner} onChange={(e) => setOppForm({ ...oppForm, owner: e.target.value })} />
                    </div>
                    <div>
                      <Label>Notes</Label>
                      <Textarea value={oppForm.notes} onChange={(e) => setOppForm({ ...oppForm, notes: e.target.value })} />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button onClick={() => createOpp.mutate()} disabled={!oppForm.title || createOpp.isPending} className="bg-gradient-primary shadow-glow">
                      Save
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            {opportunities.length === 0 ? (
              <EmptyState title="No opportunities yet" description="Convert a lead or add one directly to start the pipeline." />
            ) : (
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                {stages.map((stage: any) => (
                  <div key={stage.id} className="flex flex-col gap-2">
                    <div className="flex items-center justify-between px-1">
                      <span className="text-xs font-semibold uppercase text-muted-foreground">{stage.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {opportunities.filter((o: any) => o.stage === stage.name).length}
                      </span>
                    </div>
                    <div className="flex flex-col gap-2">
                      {opportunities
                        .filter((o: any) => o.stage === stage.name)
                        .map((o: any) => (
                          <Card key={o.id} className="glass p-3">
                            <div className="flex items-start justify-between gap-2">
                              <div className="text-sm font-medium">{o.title}</div>
                              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => deleteOpp.mutate(o.id)}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                            {o.customer_name && <div className="text-xs text-muted-foreground">{o.customer_name}</div>}
                            <div className="mt-1 text-xs text-muted-foreground">
                              {money(o.value)} · {o.probability}%
                            </div>
                            <Select value={o.stage} onValueChange={(v) => moveStage.mutate({ id: o.id, stage: v })}>
                              <SelectTrigger className="mt-2 h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {stages.map((s: any) => (
                                  <SelectItem key={s.id} value={s.name}>
                                    {s.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </Card>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* --- Tasks & Activities --- */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <ListChecks className="h-4 w-4" />
                Tasks & Activities
              </h2>
              <Dialog open={taskOpen} onOpenChange={setTaskOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline">
                    <Plus className="mr-2 h-4 w-4" />
                    New task
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>New task</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-3">
                    <div>
                      <Label>Title *</Label>
                      <Input value={taskForm.title} onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })} />
                    </div>
                    <div>
                      <Label>Description</Label>
                      <Textarea value={taskForm.description} onChange={(e) => setTaskForm({ ...taskForm, description: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <Label>Due date</Label>
                        <Input type="date" value={taskForm.due_date} onChange={(e) => setTaskForm({ ...taskForm, due_date: e.target.value })} />
                      </div>
                      <div>
                        <Label>Priority</Label>
                        <Select value={taskForm.priority} onValueChange={(v) => setTaskForm({ ...taskForm, priority: v })}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {TASK_PRIORITIES.map((p) => (
                              <SelectItem key={p} value={p}>
                                {p}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>Assigned to</Label>
                        <Input value={taskForm.assigned_to} onChange={(e) => setTaskForm({ ...taskForm, assigned_to: e.target.value })} />
                      </div>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button onClick={() => createTask.mutate()} disabled={!taskForm.title || createTask.isPending} className="bg-gradient-primary shadow-glow">
                      Save
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            {tasks.length === 0 ? (
              <EmptyState title="No tasks yet" description="Add follow-ups and activities for your leads and opportunities." />
            ) : (
              <div className="grid gap-2">
                {tasks.map((t: any) => (
                  <Card key={t.id} className="glass flex flex-wrap items-center gap-3 p-3">
                    <div className="flex-1 min-w-[200px]">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{t.title}</span>
                        <Badge variant={statusBadgeVariant(t.status)}>{t.status}</Badge>
                        <Badge variant="outline">{t.priority}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t.due_date ? `Due ${new Date(t.due_date).toLocaleDateString()}` : "No due date"}
                        {t.assigned_to ? ` · ${t.assigned_to}` : ""}
                      </div>
                    </div>
                    <Select value={t.status} onValueChange={(v) => cycleTaskStatus.mutate({ id: t.id, status: v })}>
                      <SelectTrigger className="h-8 w-32 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TASK_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button size="icon" variant="ghost" onClick={() => deleteTask.mutate(t.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </Card>
                ))}
              </div>
            )}
          </section>

          {/* --- Calendar --- */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <CalendarClock className="h-4 w-4" />
                Calendar
              </h2>
              <Dialog open={eventOpen} onOpenChange={setEventOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline">
                    <Plus className="mr-2 h-4 w-4" />
                    New event
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>New event</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-3">
                    <div>
                      <Label>Title *</Label>
                      <Input value={eventForm.title} onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Start *</Label>
                        <Input
                          type="datetime-local"
                          value={eventForm.start_time}
                          onChange={(e) => setEventForm({ ...eventForm, start_time: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label>End</Label>
                        <Input
                          type="datetime-local"
                          value={eventForm.end_time}
                          onChange={(e) => setEventForm({ ...eventForm, end_time: e.target.value })}
                        />
                      </div>
                    </div>
                    <div>
                      <Label>Description</Label>
                      <Textarea value={eventForm.description} onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })} />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      onClick={() => createEvent.mutate()}
                      disabled={!eventForm.title || !eventForm.start_time || createEvent.isPending}
                      className="bg-gradient-primary shadow-glow"
                    >
                      Save
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            {events.length === 0 ? (
              <EmptyState title="No events yet" description="Schedule calls, demos, and meetings." />
            ) : (
              <div className="grid gap-2">
                {events.map((ev: any) => (
                  <Card key={ev.id} className="glass flex flex-wrap items-center gap-3 p-3">
                    <div className="flex-1 min-w-[200px]">
                      <div className="text-sm font-medium">{ev.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(ev.start_time).toLocaleString()}
                        {ev.end_time ? ` – ${new Date(ev.end_time).toLocaleString()}` : ""}
                      </div>
                      {ev.description && <div className="mt-1 text-xs text-muted-foreground">{ev.description}</div>}
                    </div>
                    <Button size="icon" variant="ghost" onClick={() => deleteEvent.mutate(ev.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </Card>
                ))}
              </div>
            )}
          </section>

          {/* --- Approval Workflow --- */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <ShieldCheck className="h-4 w-4" />
                Approval Workflow
              </h2>
              <Dialog open={approvalOpen} onOpenChange={setApprovalOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline">
                    <Plus className="mr-2 h-4 w-4" />
                    Request approval
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Request approval</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-3">
                    <div>
                      <Label>Type</Label>
                      <Select value={approvalForm.type} onValueChange={(v) => setApprovalForm({ ...approvalForm, type: v })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {APPROVAL_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Requested by</Label>
                        <Input value={approvalForm.requested_by} onChange={(e) => setApprovalForm({ ...approvalForm, requested_by: e.target.value })} />
                      </div>
                      <div>
                        <Label>Approver</Label>
                        <Input value={approvalForm.approver} onChange={(e) => setApprovalForm({ ...approvalForm, approver: e.target.value })} />
                      </div>
                    </div>
                    <div>
                      <Label>Notes</Label>
                      <Textarea value={approvalForm.notes} onChange={(e) => setApprovalForm({ ...approvalForm, notes: e.target.value })} />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button onClick={() => createApproval.mutate()} disabled={createApproval.isPending} className="bg-gradient-primary shadow-glow">
                      Submit
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            {approvals.length === 0 ? (
              <EmptyState title="No approval requests yet" description="Discounts, contracts, and proposals awaiting sign-off show up here." />
            ) : (
              <div className="grid gap-2">
                {approvals.map((a: any) => (
                  <Card key={a.id} className="glass flex flex-wrap items-center gap-3 p-3">
                    <div className="flex-1 min-w-[200px]">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium capitalize">{a.type}</span>
                        <Badge variant={statusBadgeVariant(a.status)}>{a.status}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {a.requested_by ? `Requested by ${a.requested_by}` : ""}
                        {a.approver ? ` · Approver: ${a.approver}` : ""}
                      </div>
                      {a.notes && <div className="mt-1 text-xs text-muted-foreground">{a.notes}</div>}
                    </div>
                    {a.status === "Pending" && (
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => decideApproval.mutate({ id: a.id, status: "Approved" })}>
                          Approve
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => decideApproval.mutate({ id: a.id, status: "Rejected" })}>
                          Reject
                        </Button>
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
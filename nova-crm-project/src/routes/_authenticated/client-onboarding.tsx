import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity, AlertCircle, BadgeIndianRupee, Banknote, Bell, BriefcaseBusiness, Building2,
  CheckCircle2, ChevronRight, ClipboardCheck, Copy, CreditCard, Edit3, ExternalLink, FileText,
  FolderOpen, Landmark, Loader2, Paperclip, Plus, QrCode, ReceiptIndianRupee, RefreshCw,
  Save, ScrollText, ShoppingCart, Trash2, Users, Video, Wallet, Search, X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/client-onboarding")({
  head: () => ({
    meta: [
      { title: "Client Onboarding — Nova CRM" },
      {
        name: "description",
        content:
          "Complete client contract workspace for onboarding, project, agreement, service, team, meetings, documents, billing, invoices, purchase orders and payments.",
      },
    ],
  }),
  component: ClientOnboarding,
});

type AnyRecord = Record<string, any>;

const SECTIONS = [
  { id: "overview", label: "Overview", icon: Building2 },
  { id: "onboarding", label: "Client Onboarding", icon: ClipboardCheck },
  { id: "project-start", label: "Project Start", icon: BriefcaseBusiness },
  { id: "agreement", label: "Agreement / Contract", icon: ScrollText },
  { id: "service", label: "Service Details", icon: Landmark },
  { id: "team", label: "Project Team", icon: Users },
  { id: "meetings", label: "Meetings & MoM", icon: Video },
  { id: "documents", label: "Attachments", icon: Paperclip },
  { id: "billing", label: "Billing", icon: BadgeIndianRupee },
  { id: "invoices", label: "Invoices", icon: ReceiptIndianRupee },
  { id: "purchase-orders", label: "Purchase Orders", icon: ShoppingCart },
  { id: "payments", label: "Payments", icon: Wallet },
  { id: "activity", label: "Activity", icon: Activity },
];

const RESOURCE_CONFIG: Record<string, {
  label: string;
  fields: { key: string; label: string; type?: "date" | "datetime" | "number" | "boolean" | "textarea" | "user"; required?: boolean }[];
}> = {
  team: {
    label: "Project Team",
    fields: [
      { key: "member_user_id", label: "Existing CRM login user", type: "user", required: true },
      { key: "role", label: "Role" },
      { key: "department", label: "Department" },
      { key: "assignment_start_date", label: "Assignment start", type: "date" },
      { key: "assignment_end_date", label: "Assignment end", type: "date" },
      { key: "is_current", label: "Currently assigned", type: "boolean" },
      { key: "responsibilities", label: "Responsibilities", type: "textarea" },
    ],
  },
  meetings: {
    label: "Meetings & MoM",
    fields: [
      { key: "meeting_title", label: "Meeting title", required: true },
      { key: "meeting_date", label: "Meeting date", type: "datetime", required: true },
      { key: "meeting_type", label: "Meeting type" },
      { key: "participants", label: "Participants", type: "textarea" },
      { key: "discussion", label: "Discussion", type: "textarea" },
      { key: "minutes_of_meeting", label: "Minutes / MoM", type: "textarea" },
      { key: "action_items", label: "Action items", type: "textarea" },
      { key: "notes_storage_url", label: "Meeting notes location" },
    ],
  },
  documents: {
    label: "Attachments",
    fields: [
      { key: "file_name", label: "File name", required: true },
      { key: "document_type", label: "Document type", required: true },
      { key: "file_url", label: "File URL", required: true },
      { key: "is_client_visible", label: "Visible to client", type: "boolean" },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
  },
  billing: {
    label: "Billing",
    fields: [
      { key: "billing_cycle_name", label: "Billing cycle name", required: true },
      { key: "billing_frequency", label: "Billing frequency", required: true },
      { key: "billing_amount", label: "Billing amount", type: "number", required: true },
      { key: "currency", label: "Currency" },
      { key: "first_billing_date", label: "First billing date", type: "date" },
      { key: "next_billing_date", label: "Next billing date", type: "date" },
      { key: "cycle_start_date", label: "Cycle start", type: "date" },
      { key: "cycle_end_date", label: "Cycle end", type: "date" },
      { key: "status", label: "Status" },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
  },
  invoices: {
    label: "Invoices",
    fields: [
      { key: "invoice_number", label: "Invoice number", required: true },
      { key: "invoice_date", label: "Invoice date", type: "date" },
      { key: "due_date", label: "Due date", type: "date" },
      { key: "total_amount", label: "Total amount", type: "number" },
      { key: "currency", label: "Currency" },
      { key: "status", label: "Status" },
      { key: "generated_in_software", label: "Generated in this software", type: "boolean" },
      { key: "generated_at", label: "Generated on", type: "datetime" },
      { key: "invoice_url", label: "Invoice document URL" },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
  },
  purchase_orders: {
    label: "Purchase Orders",
    fields: [
      { key: "po_number", label: "PO number", required: true },
      { key: "issue_date", label: "PO issued", type: "date" },
      { key: "amount", label: "PO amount", type: "number" },
      { key: "currency", label: "Currency" },
      { key: "validity_start_date", label: "Valid from", type: "date" },
      { key: "validity_end_date", label: "Valid until", type: "date" },
      { key: "status", label: "Status" },
      { key: "po_document_url", label: "PO document URL" },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
  },
  payments: {
    label: "Payments",
    fields: [
      { key: "payment_date", label: "Payment date", type: "date", required: true },
      { key: "amount_received", label: "Amount received", type: "number", required: true },
      { key: "currency", label: "Currency" },
      { key: "payment_status", label: "Payment status", required: true },
      { key: "payment_method", label: "Payment method" },
      { key: "received_account", label: "Received account" },
      { key: "payment_reference", label: "Payment reference" },
      { key: "transaction_reference", label: "Transaction reference" },
      { key: "receipt_url", label: "Receipt URL" },
      { key: "notes", label: "Notes", type: "textarea" },
    ],
  },
};

function getAuthToken() {
  const keys = ["nova_auth_token", "nova_crm_token", "auth_token", "access_token", "token"];
  for (const key of keys) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.token) return parsed.token;
      if (parsed?.accessToken) return parsed.accessToken;
    } catch {
      return raw;
    }
  }
  return null;
}

async function api(path: string, options: RequestInit = {}) {
  const token = getAuthToken();
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...options, headers });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json().catch(() => ({})) : null;
  if (!response.ok) throw new Error(body?.message || body?.error || `Request failed (${response.status})`);
  return body;
}

function formatDate(value: any) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateTime(value: any) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function money(value: any, currency = "INR") {
  const n = Number(value || 0);
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

/* ---------- design tokens (visual layer only) ----------
   Palette pulled from the Nova CRM client-portal reference:
   navy sidebar/ink, sky-blue primary, and a rotating set of
   soft tinted "chip" colors per section so each area of the
   workspace reads as its own zone rather than one flat list. */
const ZONE_STYLES: Record<string, { chip: string; icon: string; ring: string }> = {
  overview: { chip: "bg-blue-50", icon: "text-blue-600", ring: "ring-blue-100" },
  onboarding: { chip: "bg-emerald-50", icon: "text-emerald-600", ring: "ring-emerald-100" },
  "project-start": { chip: "bg-amber-50", icon: "text-amber-600", ring: "ring-amber-100" },
  agreement: { chip: "bg-indigo-50", icon: "text-indigo-600", ring: "ring-indigo-100" },
  service: { chip: "bg-cyan-50", icon: "text-cyan-600", ring: "ring-cyan-100" },
  team: { chip: "bg-violet-50", icon: "text-violet-600", ring: "ring-violet-100" },
  meetings: { chip: "bg-rose-50", icon: "text-rose-600", ring: "ring-rose-100" },
  documents: { chip: "bg-sky-50", icon: "text-sky-600", ring: "ring-sky-100" },
  billing: { chip: "bg-orange-50", icon: "text-orange-600", ring: "ring-orange-100" },
  invoices: { chip: "bg-teal-50", icon: "text-teal-600", ring: "ring-teal-100" },
  "purchase-orders": { chip: "bg-fuchsia-50", icon: "text-fuchsia-600", ring: "ring-fuchsia-100" },
  payments: { chip: "bg-lime-50", icon: "text-lime-700", ring: "ring-lime-100" },
  activity: { chip: "bg-slate-100", icon: "text-slate-600", ring: "ring-slate-200" },
};

function statusTone(value: any) {
  const v = String(value || "").toLowerCase();
  if (["completed", "active", "paid", "received", "current", "generated"].some(k => v.includes(k)))
    return "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200";
  if (["pending", "in progress", "processing", "uploaded"].some(k => v.includes(k)))
    return "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200";
  if (["overdue", "failed", "cancelled", "canceled", "rejected"].some(k => v.includes(k)))
    return "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200";
  return "bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200";
}

function StatusPill({ value }: { value: any }) {
  if (!value) return <span className="text-sm text-slate-400">—</span>;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(value)}`}>
      {value}
    </span>
  );
}

/* ---------------- Razorpay checkout (UPI / Google Pay / cards) ---------------- */

declare global {
  interface Window { Razorpay?: any; }
}

let razorpayScriptPromise: Promise<boolean> | null = null;
function loadRazorpayScript(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  if (razorpayScriptPromise) return razorpayScriptPromise;
  razorpayScriptPromise = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
  return razorpayScriptPromise;
}

/* "Pay Now" — creates a Razorpay order for the invoice's outstanding
   amount, opens Razorpay Checkout (UPI / Google Pay / cards / netbanking),
   then asks the server to verify the signature before refreshing. */
function PayNowButton({ contractId, invoice, onPaid }: { contractId: number; invoice: AnyRecord; onPaid: () => void }) {
  const [loading, setLoading] = useState(false);

  const pay = async () => {
    setLoading(true);
    try {
      const scriptOk = await loadRazorpayScript();
      if (!scriptOk) throw new Error("Could not load the payment checkout. Check your connection and try again.");

      const order = await api(`/api/client/contracts/${contractId}/invoices/${invoice.id}/razorpay-order`, { method: "POST" });

      const rzp = new window.Razorpay({
        key: order.key_id,
        amount: order.amount,
        currency: order.currency,
        name: "Nova CRM",
        description: `Invoice ${invoice.invoice_number || ""}`,
        order_id: order.order_id,
        prefill: order.prefill,
        theme: { color: "#2563eb" },
        handler: async (response: any) => {
          try {
            await api(`/api/client/contracts/${contractId}/payments/verify`, {
              method: "POST",
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
              }),
            });
            toast.success("Payment received — thank you!");
            onPaid();
          } catch (e: any) {
            toast.error(e.message || "Payment succeeded but verification failed — it will still confirm shortly.");
          }
        },
        modal: { ondismiss: () => setLoading(false) },
      });
      rzp.on("payment.failed", (resp: any) => {
        toast.error(resp?.error?.description || "Payment failed. Please try again.");
        setLoading(false);
      });
      rzp.open();
    } catch (e: any) {
      toast.error(e.message || "Could not start payment.");
      setLoading(false);
    }
  };

  return (
    <Button size="sm" onClick={pay} disabled={loading}>
      {loading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <CreditCard className="mr-2 h-3.5 w-3.5" />}
      Pay Now
    </Button>
  );
}

/* Client self-reports a bank transfer / UPI-outside-gateway payment against
   an invoice; staff then confirms it from the Payments section. */
function ReportBankTransferDialog({ open, onOpenChange, contractId, invoice, onReported }: {
  open: boolean; onOpenChange: (v: boolean) => void; contractId: number; invoice?: AnyRecord | null; onReported: () => void;
}) {
  const [form, setForm] = useState<AnyRecord>({ bank_account_id: "", amount_received: invoice?.total_amount || "", transaction_reference: "", payment_date: "", receipt_url: "", notes: "" });
  const bankAccountsQuery = useQuery({
    queryKey: ["client-bank-accounts"],
    queryFn: () => api("/api/client/bank-accounts"),
    enabled: open,
  });
  const accounts: AnyRecord[] = bankAccountsQuery.data?.bank_accounts || [];
  const selected = accounts.find(a => String(a.id) === String(form.bank_account_id));

  const submit = useMutation({
    mutationFn: () => api(`/api/client/contracts/${contractId}/payments/bank-transfer`, {
      method: "POST",
      body: JSON.stringify({ ...form, invoice_id: invoice?.id || null, currency: invoice?.currency || "INR" }),
    }),
    onSuccess: () => { toast.success("Bank transfer reported — our team will confirm it shortly."); onOpenChange(false); onReported(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>Report a bank transfer</DialogTitle></DialogHeader>
        <div className="grid gap-4">
          <div>
            <Label>Transferred to</Label>
            <select className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm" value={form.bank_account_id} onChange={e => setForm(x => ({ ...x, bank_account_id: e.target.value }))}>
              <option value="">Select an account…</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.account_label}</option>)}
            </select>
            {selected && (
              <div className="mt-2 space-y-1 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                {selected.account_holder_name && <div>Account holder: <span className="font-medium text-foreground">{selected.account_holder_name}</span></div>}
                {selected.bank_name && <div>Bank: <span className="font-medium text-foreground">{selected.bank_name}</span></div>}
                {selected.account_number && <div>Account no.: <span className="font-medium text-foreground">{selected.account_number}</span></div>}
                {selected.ifsc_code && <div>IFSC: <span className="font-medium text-foreground">{selected.ifsc_code}</span></div>}
                {selected.upi_id && <div>UPI ID: <span className="font-medium text-foreground">{selected.upi_id}</span></div>}
              </div>
            )}
          </div>
          <div><Label>Amount transferred *</Label><Input className="mt-1" type="number" value={form.amount_received} onChange={e => setForm(x => ({ ...x, amount_received: e.target.value }))} /></div>
          <div><Label>Transaction / UTR reference *</Label><Input className="mt-1" value={form.transaction_reference} onChange={e => setForm(x => ({ ...x, transaction_reference: e.target.value }))} /></div>
          <div><Label>Transfer date</Label><Input className="mt-1" type="date" value={form.payment_date} onChange={e => setForm(x => ({ ...x, payment_date: e.target.value }))} /></div>
          <div><Label>Receipt / screenshot URL</Label><Input className="mt-1" value={form.receipt_url} onChange={e => setForm(x => ({ ...x, receipt_url: e.target.value }))} /></div>
          <div><Label>Notes</Label><Textarea className="mt-1" value={form.notes} onChange={e => setForm(x => ({ ...x, notes: e.target.value }))} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={submit.isPending || !form.amount_received || !form.transaction_reference} onClick={() => submit.mutate()}>
            {submit.isPending ? "Submitting…" : "Report transfer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function copyToClipboard(value: string, label: string) {
  navigator.clipboard?.writeText(value).then(
    () => toast.success(`${label} copied.`),
    () => toast.error("Could not copy to clipboard.")
  );
}

/* Client-facing read-only view of the company's receiving bank/UPI
   details, so they can see where to transfer before (or instead of)
   opening the "Report a bank transfer" dialog. */
function BankDetailsCard() {
  const { data, isLoading } = useQuery({
    queryKey: ["client-bank-accounts"],
    queryFn: () => api("/api/client/bank-accounts"),
  });
  const accounts: AnyRecord[] = data?.bank_accounts || [];

  if (isLoading || !accounts.length) return null;

  return (
    <div className="mb-4 grid gap-3 md:grid-cols-2">
      {accounts.map((acc) => (
        <div key={acc.id} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 font-semibold text-slate-900"><Landmark className="h-4 w-4 text-blue-600" />{acc.account_label}</div>
          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <Field label="Account holder" value={acc.account_holder_name} />
            <Field label="Bank" value={acc.bank_name} />
            {acc.branch && <Field label="Branch" value={acc.branch} />}
            {acc.account_number && (
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Account number</div>
                <div className="mt-1 flex items-center gap-1.5 text-sm font-medium text-slate-800">
                  {acc.account_number}
                  <button type="button" onClick={() => copyToClipboard(acc.account_number, "Account number")} className="text-slate-400 hover:text-blue-600"><Copy className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            )}
            {acc.ifsc_code && (
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">IFSC code</div>
                <div className="mt-1 flex items-center gap-1.5 text-sm font-medium text-slate-800">
                  {acc.ifsc_code}
                  <button type="button" onClick={() => copyToClipboard(acc.ifsc_code, "IFSC code")} className="text-slate-400 hover:text-blue-600"><Copy className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            )}
            {acc.upi_id && (
              <div className="sm:col-span-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">UPI / Google Pay ID</div>
                <div className="mt-1 flex items-center gap-1.5 text-sm font-medium text-slate-800">
                  <QrCode className="h-3.5 w-3.5 text-blue-600" />{acc.upi_id}
                  <button type="button" onClick={() => copyToClipboard(acc.upi_id, "UPI ID")} className="text-slate-400 hover:text-blue-600"><Copy className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* Staff-only: manage the company's receiving bank accounts shown to
   clients for manual bank transfer / UPI payments. */
function AdminBankAccountsManager() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AnyRecord | null>(null);
  const [form, setForm] = useState<AnyRecord>({ account_label: "", account_holder_name: "", bank_name: "", account_number: "", ifsc_code: "", upi_id: "", branch: "", is_active: true });

  const accountsQuery = useQuery({ queryKey: ["admin-bank-accounts"], queryFn: () => api("/api/admin/bank-accounts") });
  const accounts: AnyRecord[] = accountsQuery.data?.bank_accounts || [];

  const startAdd = () => { setEditing(null); setForm({ account_label: "", account_holder_name: "", bank_name: "", account_number: "", ifsc_code: "", upi_id: "", branch: "", is_active: true }); setOpen(true); };
  const startEdit = (row: AnyRecord) => { setEditing(row); setForm({ ...row }); setOpen(true); };

  const save = useMutation({
    mutationFn: () => api(`/api/admin/bank-accounts${editing?.id ? `/${editing.id}` : ""}`, { method: editing?.id ? "PUT" : "POST", body: JSON.stringify(form) }),
    onSuccess: () => { toast.success("Bank account saved."); setOpen(false); qc.invalidateQueries({ queryKey: ["admin-bank-accounts"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/admin/bank-accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Bank account removed."); qc.invalidateQueries({ queryKey: ["admin-bank-accounts"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mb-4 rounded-xl border bg-muted/20 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div><div className="font-semibold">Bank accounts for client transfers</div><div className="text-xs text-muted-foreground">Shown to clients when they choose to pay by bank transfer / UPI.</div></div>
        <Button size="sm" onClick={startAdd}><Plus className="mr-2 h-4 w-4" />Add account</Button>
      </div>
      {accounts.length > 0 && (
        <div className="space-y-2">
          {accounts.map(row => (
            <div key={row.id} className="flex flex-col gap-2 rounded-lg border bg-background p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium">{row.account_label}{!row.is_active && <Badge variant="secondary">Inactive</Badge>}</div>
                <div className="text-xs text-muted-foreground">{row.bank_name}{row.account_number ? ` • •••${String(row.account_number).slice(-4)}` : ""}{row.upi_id ? ` • ${row.upi_id}` : ""}</div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" onClick={() => startEdit(row)}><Edit3 className="mr-2 h-3.5 w-3.5" />Edit</Button>
                <Button size="sm" variant="outline" disabled={remove.isPending} onClick={() => { if (window.confirm("Remove this bank account?")) remove.mutate(Number(row.id)); }}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>{editing?.id ? "Edit bank account" : "Add bank account"}</DialogTitle></DialogHeader>
          <div className="grid gap-4">
            <div><Label>Label (shown to clients) *</Label><Input className="mt-1" value={form.account_label} onChange={e => setForm((x: AnyRecord) => ({ ...x, account_label: e.target.value }))} /></div>
            <div><Label>Account holder name</Label><Input className="mt-1" value={form.account_holder_name} onChange={e => setForm((x: AnyRecord) => ({ ...x, account_holder_name: e.target.value }))} /></div>
            <div><Label>Bank name</Label><Input className="mt-1" value={form.bank_name} onChange={e => setForm((x: AnyRecord) => ({ ...x, bank_name: e.target.value }))} /></div>
            <div><Label>Account number</Label><Input className="mt-1" value={form.account_number} onChange={e => setForm((x: AnyRecord) => ({ ...x, account_number: e.target.value }))} /></div>
            <div><Label>IFSC code</Label><Input className="mt-1" value={form.ifsc_code} onChange={e => setForm((x: AnyRecord) => ({ ...x, ifsc_code: e.target.value }))} /></div>
            <div><Label>UPI ID</Label><Input className="mt-1" value={form.upi_id} onChange={e => setForm((x: AnyRecord) => ({ ...x, upi_id: e.target.value }))} /></div>
            <div><Label>Branch</Label><Input className="mt-1" value={form.branch} onChange={e => setForm((x: AnyRecord) => ({ ...x, branch: e.target.value }))} /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(form.is_active)} onChange={e => setForm((x: AnyRecord) => ({ ...x, is_active: e.target.checked }))} />Active (visible to clients)</label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={save.isPending || !form.account_label} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save account"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* Staff-only bell — recent payment/onboarding notifications with unread count. */
function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const notificationsQuery = useQuery({
    queryKey: ["admin-notifications"],
    queryFn: () => api("/api/admin/notifications"),
    refetchInterval: 30000,
  });
  const notifications: AnyRecord[] = notificationsQuery.data?.notifications || [];
  const unreadCount = notificationsQuery.data?.unread_count || 0;

  const markRead = useMutation({
    mutationFn: (id: number) => api(`/api/admin/notifications/${id}/read`, { method: "PUT" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-notifications"] }),
  });
  const markAllRead = useMutation({
    mutationFn: () => api(`/api/admin/notifications/read-all`, { method: "PUT" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-notifications"] }),
  });

  return (
    <div className="relative">
      <Button variant="outline" size="sm" className="relative" onClick={() => setOpen(x => !x)}>
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">{unreadCount}</span>}
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-xl border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div className="text-sm font-semibold">Notifications</div>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => markAllRead.mutate()}>Mark all read</Button>}
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setOpen(false)}><X className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {!notifications.length ? (
              <div className="p-4 text-center text-sm text-muted-foreground">No notifications yet.</div>
            ) : notifications.map(n => (
              <button key={n.id} type="button" onClick={() => !n.is_read && markRead.mutate(Number(n.id))}
                className={`block w-full border-b px-3 py-2.5 text-left text-sm last:border-b-0 hover:bg-muted/50 ${!n.is_read ? "bg-blue-50/50" : ""}`}>
                <div className="flex items-start gap-2">
                  {!n.is_read && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-600" />}
                  <div className="min-w-0">
                    <div className="font-medium">{n.title}</div>
                    {n.message && <div className="mt-0.5 text-xs text-muted-foreground">{n.message}</div>}
                    <div className="mt-1 text-[11px] text-muted-foreground">{n.client_company_name || n.contract_number || ""} • {formatDateTime(n.created_at)}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* Staff-only confirm/reject controls for a payment awaiting confirmation
   (i.e. a client-reported bank transfer that hasn't been checked yet). */
function PaymentConfirmActions({ contractId, payment, onDone }: { contractId: number; payment: AnyRecord; onDone: () => void }) {
  const mutation = useMutation({
    mutationFn: (action: "confirm" | "reject") =>
      api(`/api/admin/client-contracts/${contractId}/payments/${payment.id}/confirm`, { method: "PUT", body: JSON.stringify({ action }) }),
    onSuccess: (_, action) => { toast.success(action === "confirm" ? "Payment confirmed." : "Payment rejected."); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mt-4 flex gap-2 border-t border-slate-100 pt-4">
      <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate("confirm")}><CheckCircle2 className="mr-2 h-3.5 w-3.5" />Confirm received</Button>
      <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate("reject")}>Reject</Button>
    </div>
  );
}

function Section({ id, title, description, icon: Icon, children }: {
  id: string; title: string; description: string; icon: any; children: ReactNode;
}) {
  const zone = ZONE_STYLES[id] || ZONE_STYLES.overview;
  return (
    <section id={id} className="scroll-mt-6">
      <Card className="overflow-hidden rounded-2xl border-slate-200/80 shadow-sm">
        <div className="flex items-start gap-3 border-b border-slate-100 bg-white px-5 py-4">
          <div className={`rounded-xl p-2.5 ring-1 ${zone.chip} ${zone.icon} ${zone.ring}`}><Icon className="h-4 w-4" /></div>
          <div><h2 className="font-semibold text-slate-900">{title}</h2><p className="text-sm text-slate-500">{description}</p></div>
        </div>
        <div className="bg-slate-50/40 p-5">{children}</div>
      </Card>
    </section>
  );
}

function Field({ label, value, wide = false }: { label: string; value: any; wide?: boolean }) {
  return (
    <div className={wide ? "md:col-span-2" : ""}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 whitespace-pre-wrap text-sm font-medium text-slate-800">{value || "—"}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-400">{children}</div>;
}

function Metric({ label, value }: { label: string; value: any }) {
  return <div className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div><div className="mt-1 truncate text-sm font-bold text-slate-900">{value || "—"}</div></div>;
}

function ResourceDialog({ open, onOpenChange, resource, initial, onSubmit, pending }: {
  open: boolean; onOpenChange: (v: boolean) => void; resource: string;
  initial?: AnyRecord | null; onSubmit: (value: AnyRecord) => void; pending: boolean;
}) {
  const config = RESOURCE_CONFIG[resource];
  const makeInitial = () => Object.fromEntries(config.fields.map(f => [f.key, initial?.[f.key] ?? (f.type === "boolean" ? false : "")]));
  const [form, setForm] = useState<AnyRecord>(makeInitial());
  const usersQuery = useQuery({
    queryKey: ["admin-client-users"],
    queryFn: () => api("/api/admin/client-users") as Promise<AnyRecord[]>,
    enabled: resource === "team" && open,
    retry: false,
  });

  // Reinitialize when a different record/resource is opened.
  const key = `${resource}:${initial?.id || "new"}:${open}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent key={key} className="max-h-[90vh] overflow-y-auto rounded-2xl sm:max-w-2xl">
        <DialogHeader><DialogTitle className="text-slate-900">{initial?.id ? `Edit ${config.label}` : `Add ${config.label}`}</DialogTitle></DialogHeader>
        <div className="grid gap-4">
          {config.fields.map(field => (
            <div key={field.key}>
              <Label className="text-slate-600">{field.label}{field.required ? " *" : ""}</Label>
              {field.type === "user" ? (
                <>
                  <Select
                    value={form[field.key] ?? ""}
                    disabled={resource === "team" && String(initial?.assignment_status || "").toLowerCase() === "accepted"}
                    onValueChange={v => setForm(x => ({ ...x, [field.key]: v }))}
                  >
                    <SelectTrigger className="mt-1 rounded-xl border-slate-200"><SelectValue placeholder={usersQuery.isLoading ? "Loading CRM login users..." : "Select an existing verified login user"} /></SelectTrigger>
                    <SelectContent>
                      {(usersQuery.data || []).filter((u: AnyRecord) => u.email_verified).map((u: AnyRecord) => (
                        <SelectItem key={u.id} value={u.id}>{u.full_name || "Unnamed user"} — {u.email}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {resource === "team" && String(initial?.assignment_status || "").toLowerCase() === "accepted" && (
                    <p className="mt-1 text-xs text-slate-500">This login user already accepted the assignment. To assign another user, create a new assignment request.</p>
                  )}
                </>
              ) : field.type === "textarea" ? (
                <Textarea className="mt-1 min-h-24 rounded-xl border-slate-200" value={form[field.key] ?? ""} onChange={e => setForm(x => ({...x, [field.key]: e.target.value}))} />
              ) : field.type === "boolean" ? (
                <label className="mt-2 flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" checked={Boolean(form[field.key])} onChange={e => setForm(x => ({...x, [field.key]: e.target.checked}))} />
                  {field.label}
                </label>
              ) : (
                <Input
                  className="mt-1 rounded-xl border-slate-200"
                  type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "datetime" ? "datetime-local" : "text"}
                  value={field.type === "datetime" && form[field.key] ? String(form[field.key]).slice(0,16) : (form[field.key] ?? "")}
                  onChange={e => setForm(x => ({...x, [field.key]: e.target.value}))}
                />
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" className="rounded-xl border-slate-200" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="rounded-xl bg-blue-600 hover:bg-blue-700" disabled={pending || config.fields.some(f => f.required && !String(form[f.key] ?? "").trim())} onClick={() => onSubmit(form)}>
            {pending ? "Saving…" : "Save record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdminResourceManager({ resource, records, contractId, onRefresh }: {
  resource: string; records: AnyRecord[]; contractId: number; onRefresh: () => void;
}) {
  const config = RESOURCE_CONFIG[resource];
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AnyRecord | null>(null);
  const mutation = useMutation({
    mutationFn: (payload: { id?: number; value: AnyRecord }) =>
      api(`/api/admin/client-contracts/${contractId}/${resource}${payload.id ? `/${payload.id}` : ""}`, {
        method: payload.id ? "PUT" : "POST", body: JSON.stringify(payload.value),
      }),
    onSuccess: () => { toast.success(`${config.label} saved.`); setOpen(false); setEditing(null); onRefresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/admin/client-contracts/${contractId}/${resource}/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Record deleted."); onRefresh(); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div><div className="font-semibold text-slate-900">Admin management</div><div className="text-xs text-slate-500">Add, edit or remove {config.label.toLowerCase()} records.</div></div>
        <Button size="sm" className="rounded-xl bg-blue-600 hover:bg-blue-700" onClick={() => { setEditing(null); setOpen(true); }}><Plus className="mr-2 h-4 w-4" />Add</Button>
      </div>
      {records.length > 0 && (
        <div className="space-y-2">
          {records.map((row) => (
            <div key={row.id} className="flex flex-col gap-2 rounded-xl border border-slate-100 bg-slate-50/60 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="font-medium text-slate-900">{row.member_name || row.meeting_title || row.file_name || row.billing_cycle_name || row.invoice_number || row.po_number || (row.amount_received != null ? money(row.amount_received, row.currency) : row.id)}</div>
                <div className="text-xs text-slate-500">
                  {resource === "team" ? `${row.role || "Team member"}${row.assignment_status ? ` • ${String(row.assignment_status).charAt(0).toUpperCase() + String(row.assignment_status).slice(1)}` : ""}${row.is_current ? " • Current" : ""}` :
                   resource === "meetings" ? formatDateTime(row.meeting_date) :
                   resource === "documents" ? row.document_type :
                   resource === "billing" ? `${row.billing_frequency || ""} • ${money(row.billing_amount, row.currency)}` :
                   resource === "invoices" ? `${formatDate(row.invoice_date)} • ${row.status || ""} • ${row.generated_in_software ? "Generated in software" : "Generated externally"}` :
                   resource === "purchase_orders" ? `${formatDate(row.issue_date)} • ${row.status || ""}` :
                   `${formatDate(row.payment_date)} • ${row.payment_status || ""}`}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" className="rounded-xl border-slate-200" onClick={() => { setEditing(row); setOpen(true); }}><Edit3 className="mr-2 h-3.5 w-3.5" />Edit</Button>
                <Button size="sm" variant="outline" className="rounded-xl border-slate-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700" disabled={remove.isPending} onClick={() => { if (window.confirm("Delete this record?")) remove.mutate(Number(row.id)); }}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <ResourceDialog open={open} onOpenChange={setOpen} resource={resource} initial={editing} pending={mutation.isPending}
        onSubmit={(value) => mutation.mutate({ id: editing?.id, value })} />
    </div>
  );
}

function ClientOnboarding() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>("");
  const [activeSection, setActiveSection] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [contractEditing, setContractEditing] = useState(false);
  const [notes, setNotes] = useState({ onboarding_notes: "", project_notes: "", service_notes: "", initial_project_discussion_date: "" });
  const [adminSearch, setAdminSearch] = useState("");
  const [reportingInvoice, setReportingInvoice] = useState<AnyRecord | null>(null);

  const meQuery = useQuery({ queryKey: ["auth-me"], queryFn: () => api("/api/auth/me"), retry: false });
  const isAdmin = ["admin", "manager", "staff", "sales"].includes(String(meQuery.data?.user?.role || "").toLowerCase());

  const contractsQuery = useQuery({
    queryKey: [isAdmin ? "admin-client-contracts" : "client-contracts"],
    queryFn: async () => isAdmin
      ? api("/api/admin/client-contracts")
      : api("/api/client/contracts"),
    enabled: meQuery.isSuccess,
    retry: false,
  });

  const adminUsersQuery = useQuery({
    queryKey: ["admin-client-users"],
    queryFn: () => api("/api/admin/client-users"),
    enabled: Boolean(isAdmin),
    retry: false,
  });

  const assignmentRequestsQuery = useQuery({
    queryKey: ["client-team-assignment-requests"],
    queryFn: () => api("/api/client/team-assignment-requests") as Promise<{ requests: AnyRecord[] }>,
    enabled: !isAdmin,
    retry: false,
  });

  const respondToAssignment = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "accepted" | "declined" }) =>
      api(`/api/client/team-assignment-requests/${id}/respond`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      }),
    onSuccess: (_data: any, variables) => {
      toast.success(variables.decision === "accepted" ? "Project assignment accepted." : "Project assignment declined.");
      qc.invalidateQueries({ queryKey: ["client-team-assignment-requests"] });
      refreshWorkspace();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pendingAssignmentRequests: AnyRecord[] = assignmentRequestsQuery.data?.requests || [];

  const adminContracts: AnyRecord[] = contractsQuery.data?.contracts || [];
  const clientContracts: AnyRecord[] = contractsQuery.data?.contracts || [];
  const allContracts = isAdmin ? adminContracts : clientContracts;

  const filteredAdminUsers: AnyRecord[] = useMemo(() => {
    const q = adminSearch.trim().toLowerCase();
    const users = adminUsersQuery.data || [];
    if (!q) return users;
    return users.filter((u: AnyRecord) => [u.full_name, u.email, u.role, ...(u.contracts || []).map((c: AnyRecord) => c.client_company_name)].filter(Boolean).some((v: any) => String(v).toLowerCase().includes(q)));
  }, [adminUsersQuery.data, adminSearch]);

  const selected = useMemo(() => {
    if (!allContracts.length) return null;
    const id = selectedId || String(allContracts[0].id);
    return allContracts.find((x: AnyRecord) => String(x.id) === id) || allContracts[0];
  }, [allContracts, selectedId]);

  const workspaceQuery = useQuery({
    queryKey: [isAdmin ? "admin-contract-workspace" : "client-contract-workspace", selected?.id],
    queryFn: () => api(`${isAdmin ? "/api/admin/client-contracts" : "/api/client/contracts"}/${selected?.id}/workspace`),
    enabled: Boolean(selected?.id),
    retry: false,
  });

  const workspace = workspaceQuery.data as AnyRecord | undefined;
  const contract = workspace?.contract || selected;
  const onboarding = workspace?.onboarding;
  const team = workspace?.team || [];
  const meetings = workspace?.meetings || [];
  const documents = workspace?.documents || [];
  const billing = workspace?.billing || [];
  const invoices = workspace?.invoices || [];
  const purchaseOrders = workspace?.purchase_orders || [];
  const payments = workspace?.payments || [];
  const activity = workspace?.activity || [];
  const progress = Math.max(0, Math.min(100, Number(onboarding?.progress_percent || selected?.progress_percent || 0)));

  const refreshWorkspace = () => {
    qc.invalidateQueries({ queryKey: [isAdmin ? "admin-contract-workspace" : "client-contract-workspace", contract?.id] });
    qc.invalidateQueries({ queryKey: ["admin-client-contracts"] });
    qc.invalidateQueries({ queryKey: ["admin-client-users"] });
  };

  const saveOnboarding = useMutation({
    mutationFn: (payload: AnyRecord) => api(`/api/admin/client-contracts/${contract.id}/onboarding`, { method: "PUT", body: JSON.stringify(payload) }),
    onSuccess: () => { toast.success("Onboarding information saved."); setEditing(false); refreshWorkspace(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveContract = useMutation({
    mutationFn: (payload: AnyRecord) => api(`/api/admin/client-contracts/${contract.id}`, { method: "PUT", body: JSON.stringify(payload) }),
    onSuccess: () => { toast.success("Contract updated."); setContractEditing(false); refreshWorkspace(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const startEdit = () => {
    setNotes({
      onboarding_notes: onboarding?.onboarding_notes || "",
      project_notes: onboarding?.project_notes || "",
      service_notes: onboarding?.service_notes || "",
      initial_project_discussion_date: onboarding?.initial_project_discussion_date?.slice?.(0, 10) || "",
    });
    setEditing(true);
  };

  const startAdminOnboardingEdit = () => {
    setNotes({
      onboarding_notes: onboarding?.onboarding_notes || "",
      project_notes: onboarding?.project_notes || "",
      service_notes: onboarding?.service_notes || "",
      initial_project_discussion_date: onboarding?.initial_project_discussion_date?.slice?.(0, 10) || "",
    });
    setEditing(true);
  };

  const scrollTo = (id: string) => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (meQuery.isLoading || contractsQuery.isLoading) {
    return <div className="flex min-h-[60vh] items-center justify-center text-sm text-slate-500"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Loading client onboarding workspace…</div>;
  }

  if (meQuery.isError || contractsQuery.isError) {
    return <div className="p-6"><Card className="mx-auto max-w-xl rounded-2xl p-8 text-center shadow-sm"><AlertCircle className="mx-auto h-10 w-10 text-rose-500" /><h1 className="mt-4 text-xl font-semibold text-slate-900">Unable to load client onboarding</h1><p className="mt-2 text-sm text-slate-500">{(contractsQuery.error as Error)?.message || (meQuery.error as Error)?.message || "Please sign in again."}</p><Button className="mt-5 rounded-xl bg-blue-600 hover:bg-blue-700" onClick={() => { meQuery.refetch(); contractsQuery.refetch(); }}>Try again</Button></Card></div>;
  }

  if (isAdmin && !allContracts.length) {
    return <AdminEmptyState users={adminUsersQuery.data || []} onRefresh={() => { contractsQuery.refetch(); adminUsersQuery.refetch(); }} />;
  }

  if (!isAdmin && !allContracts.length) {
    return <div className="p-6"><Card className="mx-auto max-w-2xl rounded-2xl p-10 text-center shadow-sm"><FolderOpen className="mx-auto h-12 w-12 text-slate-300" /><h1 className="mt-5 text-2xl font-bold text-slate-900">No contract is assigned to this login</h1><p className="mt-2 text-sm text-slate-500">Your Nova CRM login is valid, but no client contract has been assigned to it yet.</p></Card></div>;
  }

  if (workspaceQuery.isLoading || !workspace) {
    return <div className="flex min-h-[60vh] items-center justify-center text-sm text-slate-500"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Loading {isAdmin ? "selected client" : "your"} workspace…</div>;
  }

  if (workspaceQuery.isError) {
    return <div className="p-6"><Card className="mx-auto max-w-xl rounded-2xl p-8 text-center shadow-sm"><AlertCircle className="mx-auto h-10 w-10 text-rose-500" /><h1 className="mt-4 text-xl font-semibold text-slate-900">Contract details unavailable</h1><p className="mt-2 text-sm text-slate-500">{(workspaceQuery.error as Error)?.message || "Please try again."}</p></Card></div>;
  }

  return (
    <div className="min-h-full bg-slate-50">
      {isAdmin && (
        <Card className="mx-4 mt-4 overflow-hidden rounded-2xl border-blue-100 bg-white shadow-sm md:mx-6">
          <div className="flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-600">Admin Control Center</div>
              <div className="mt-1 text-lg font-bold text-slate-900">All client onboarding records</div>
              <div className="text-sm text-slate-500">Select any client login or contract. Admin can manage the complete project lifecycle.</div>
            </div>
            <div className="flex items-center gap-2">
              <NotificationBell />
              <Button variant="outline" size="sm" className="rounded-xl border-slate-200" onClick={() => { contractsQuery.refetch(); adminUsersQuery.refetch(); }}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
              <Button size="sm" className="rounded-xl bg-blue-600 hover:bg-blue-700" onClick={() => window.location.assign("/client-contracts")}><Users className="mr-2 h-4 w-4" />Assign contracts</Button>
            </div>
          </div>
          <div className="border-t border-slate-100 bg-slate-50/60 p-3">
            <div className="relative max-w-xl">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input className="rounded-xl border-slate-200 bg-white pl-9" placeholder="Search client, email, company or contract..." value={adminSearch} onChange={e => setAdminSearch(e.target.value)} />
            </div>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {filteredAdminUsers.map((u: AnyRecord) => (u.contracts || []).map((c: AnyRecord) => (
                <button key={`${u.id}-${c.id}`} type="button" onClick={() => setSelectedId(String(c.id))}
                  className={`min-w-[230px] rounded-2xl border p-3 text-left transition ${String(selected?.id) === String(c.id) ? "border-blue-300 bg-blue-50 shadow-sm" : "border-slate-200 bg-white hover:bg-slate-50"}`}>
                  <div className="truncate font-semibold text-slate-900">{c.client_company_name || "Unnamed client"}</div>
                  <div className="mt-1 truncate text-xs text-slate-500">{u.full_name || u.email} • {u.email}</div>
                  <div className="mt-2 flex items-center justify-between gap-2"><Badge variant="outline" className="rounded-full border-slate-200 text-slate-600">{c.contract_number}</Badge><StatusPill value={c.onboarding_status || "Pending"} /></div>
                </button>
              )))}
            </div>
          </div>
        </Card>
      )}

      <div className="mx-auto flex max-w-[1600px] gap-5 p-4 md:p-6">
        <aside className="sticky top-4 hidden h-[calc(100vh-2rem)] w-64 shrink-0 overflow-auto rounded-2xl border border-slate-200 bg-white p-3 shadow-sm lg:block">
          <div className="px-3 py-3">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-600">{isAdmin ? "Admin Workspace" : "Client Workspace"}</div>
            <div className="mt-1 text-lg font-bold text-slate-900">Contract Onboarding</div>
            <div className="mt-1 text-xs text-slate-500">One page. Every contract detail.</div>
          </div>
          <div className="mt-2 space-y-1">
            {SECTIONS.map(item => {
              const Icon = item.icon;
              return <button key={item.id} type="button" onClick={() => scrollTo(item.id)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition ${activeSection === item.id ? "bg-blue-600 text-white shadow-sm" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"}`}>
                <Icon className="h-4 w-4 shrink-0" /><span className="truncate">{item.label}</span>{activeSection === item.id && <ChevronRight className="ml-auto h-4 w-4" />}
              </button>;
            })}
          </div>
          <div className="mt-5 rounded-2xl bg-slate-50 p-3">
            <div className="text-xs text-slate-500">Project progress</div>
            <div className="mt-2 flex items-center justify-between text-sm font-semibold text-slate-900"><span>{progress}%</span><span className="text-xs font-medium text-slate-500">{onboarding?.current_phase || "Onboarding"}</span></div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${progress}%` }} /></div>
          </div>
        </aside>

        <main className="min-w-0 flex-1 space-y-5">
          <Card className="overflow-hidden rounded-2xl border-slate-200 shadow-sm">
            <div className="bg-white p-5 md:p-7">
              <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-600 text-lg font-bold text-white shadow-lg">
                    {String(contract.client_company_name || "AT").slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold tracking-tight text-slate-900">{contract.client_company_name || contract.client_name || "Client Workspace"}</h1><StatusPill value={contract.status || "Active"} /></div>
                    <p className="mt-1 text-sm text-slate-500">{contract.contract_number} • {contract.contract_title}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {!isAdmin && allContracts.length > 1 && <select value={String(contract.id)} onChange={e => setSelectedId(e.target.value)} className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700">{allContracts.map((c: AnyRecord) => <option key={c.id} value={c.id}>{c.contract_number} — {c.contract_title}</option>)}</select>}
                      <Button variant="outline" size="sm" className="rounded-xl border-slate-200" onClick={() => workspaceQuery.refetch()}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
                      {isAdmin ? <><Button size="sm" className="rounded-xl bg-blue-600 hover:bg-blue-700" onClick={startAdminOnboardingEdit}><Edit3 className="mr-2 h-4 w-4" />Edit onboarding</Button><Button size="sm" variant="outline" className="rounded-xl border-slate-200" onClick={() => setContractEditing(true)}><ScrollText className="mr-2 h-4 w-4" />Edit contract</Button></> : <Button size="sm" className="rounded-xl bg-blue-600 hover:bg-blue-700" onClick={startEdit}><Save className="mr-2 h-4 w-4" />Update permitted notes</Button>}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Metric label="Onboarding" value={onboarding?.onboarding_status || "Pending"} />
                  <Metric label="Project start" value={formatDate(onboarding?.project_start_date)} />
                  <Metric label="Contract end" value={formatDate(contract.end_date)} />
                  <Metric label="Team" value={String(team.length)} />
                </div>
              </div>
            </div>
          </Card>

          <div className="flex gap-2 overflow-x-auto lg:hidden">{SECTIONS.map(item => <Button key={item.id} className={activeSection === item.id ? "rounded-xl bg-blue-600 hover:bg-blue-700" : "rounded-xl border-slate-200"} variant={activeSection === item.id ? "default" : "outline"} size="sm" onClick={() => scrollTo(item.id)}>{item.label}</Button>)}</div>

          {!isAdmin && (assignmentRequestsQuery.isLoading || assignmentRequestsQuery.isError || pendingAssignmentRequests.length > 0) && (
            <Card className="overflow-hidden rounded-2xl border-amber-200 bg-white shadow-sm">
              <div className="flex flex-col gap-3 border-b border-amber-100 bg-amber-50/60 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-700"><Bell className="h-5 w-5" /></div>
                  <div>
                    <div className="font-semibold text-slate-900">Project assignment requests</div>
                    <div className="text-sm text-slate-500">Accept or decline a project-team assignment sent to this login.</div>
                  </div>
                </div>
                {pendingAssignmentRequests.length > 0 && <Badge className="w-fit rounded-full bg-amber-500 text-white hover:bg-amber-500">{pendingAssignmentRequests.length} pending</Badge>}
              </div>

              <div className="p-4">
                {assignmentRequestsQuery.isLoading ? (
                  <div className="flex items-center gap-2 py-4 text-sm text-slate-500"><RefreshCw className="h-4 w-4 animate-spin" />Loading assignment requests...</div>
                ) : assignmentRequestsQuery.isError ? (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                    <div className="font-medium">Unable to load project assignment requests.</div>
                    <div className="mt-1 text-rose-600">{(assignmentRequestsQuery.error as Error)?.message || "Please refresh and try again."}</div>
                    <Button size="sm" variant="outline" className="mt-3 rounded-xl" onClick={() => assignmentRequestsQuery.refetch()}>Retry</Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {pendingAssignmentRequests.map((request) => (
                      <div key={request.id} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="font-semibold text-slate-900">{request.contract_title || request.contract_number || "Project assignment"}</div>
                              <Badge variant="outline" className="rounded-full border-amber-200 bg-amber-50 text-amber-700">Pending your response</Badge>
                            </div>
                            <div className="mt-2 grid gap-1 text-sm text-slate-600 sm:grid-cols-2">
                              <div><span className="font-medium text-slate-700">Client:</span> {request.client_company_name || "—"}</div>
                              <div><span className="font-medium text-slate-700">Contract:</span> {request.contract_number || "—"}</div>
                              <div><span className="font-medium text-slate-700">Role:</span> {request.role || "—"}</div>
                              <div><span className="font-medium text-slate-700">Department:</span> {request.department || "—"}</div>
                              {request.assignment_start_date && <div><span className="font-medium text-slate-700">Start:</span> {formatDate(request.assignment_start_date)}</div>}
                              {request.assignment_end_date && <div><span className="font-medium text-slate-700">End:</span> {formatDate(request.assignment_end_date)}</div>}
                            </div>
                            {request.responsibilities && <div className="mt-2 text-sm text-slate-600"><span className="font-medium text-slate-700">Responsibilities:</span> {request.responsibilities}</div>}
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-2">
                            <Button
                              className="rounded-xl bg-blue-600 hover:bg-blue-700"
                              disabled={respondToAssignment.isPending}
                              onClick={() => respondToAssignment.mutate({ id: Number(request.id), decision: "accepted" })}
                            >
                              <CheckCircle2 className="mr-2 h-4 w-4" />
                              {respondToAssignment.isPending ? "Saving..." : "Accept assignment"}
                            </Button>
                            <Button
                              variant="outline"
                              className="rounded-xl border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-700"
                              disabled={respondToAssignment.isPending}
                              onClick={() => respondToAssignment.mutate({ id: Number(request.id), decision: "declined" })}
                            >
                              <X className="mr-2 h-4 w-4" />Decline
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          )}

          <Section id="overview" title="Overall Project Information" description="Complete contract, login and project snapshot." icon={Building2}>
            <div className="grid gap-5 md:grid-cols-4">
              <Field label="Client / Company" value={contract.client_company_name} />
              <Field label="Login user" value={contract.client_name || contract.user_full_name} />
              <Field label="Login email" value={contract.client_email || contract.user_email} />
              <Field label="Login role" value={contract.client_role || contract.user_role} />
              <Field label="Contract status" value={contract.status} />
              <Field label="Contract number" value={contract.contract_number} />
              <Field label="Project status" value={onboarding?.project_status} />
              <Field label="Current phase" value={onboarding?.current_phase} />
              <Field label="Progress" value={`${progress}%`} />
            </div>
          </Section>

          <Section id="onboarding" title="Client Onboarding" description="Official onboarding status and completion record." icon={ClipboardCheck}>
            <div className="grid gap-5 md:grid-cols-3">
              <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Officially onboarded</div><div className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-900">{String(onboarding?.onboarding_status || "").toLowerCase() === "completed" ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <AlertCircle className="h-5 w-5 text-amber-600" />}{onboarding?.onboarding_status || "Pending"}</div></div>
              <Field label="Onboarding completed" value={formatDateTime(onboarding?.onboarding_completed_at)} />
              <Field label="Completed by" value={onboarding?.onboarding_completed_by} />
              <Field label="Onboarding notes" value={onboarding?.onboarding_notes} wide />
            </div>
          </Section>

          <Section id="project-start" title="Project Start" description="Formal commencement and initial project discussion." icon={BriefcaseBusiness}>
            <div className="grid gap-5 md:grid-cols-4">
              <Field label="Project start date" value={formatDate(onboarding?.project_start_date)} />
              <Field label="Initial project discussion" value={formatDate(onboarding?.initial_project_discussion_date)} />
              <Field label="Project status" value={onboarding?.project_status} />
              <Field label="Current phase" value={onboarding?.current_phase} />
              <Field label="Project notes" value={onboarding?.project_notes} wide />
            </div>
          </Section>

          <Section id="agreement" title="Agreement / Contract" description="Agreement dates, duration, value, services and contract document." icon={ScrollText}>
            {isAdmin && <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="font-semibold text-slate-900">Commercial master record</div><div className="text-xs text-slate-500">Admin controls dates, duration, services, contract value and document.</div></div><Button size="sm" className="rounded-xl bg-blue-600 hover:bg-blue-700" onClick={() => setContractEditing(true)}><Edit3 className="mr-2 h-4 w-4" />Edit agreement</Button></div></div>}
            <div className="grid gap-5 md:grid-cols-4">
              <Field label="Agreement start" value={formatDate(contract.start_date)} /><Field label="Agreement end" value={formatDate(contract.end_date)} /><Field label="Total duration" value={contract.total_duration} /><Field label="Contract value" value={money(contract.contract_value, contract.currency)} />
              <Field label="Services covered" value={contract.services_covered} wide /><Field label="Contract document" value={contract.contract_document_url || "—"} wide /><Field label="Contract notes" value={contract.notes} wide />
              {contract.contract_document_url && <a href={contract.contract_document_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-medium text-blue-600 hover:underline"><ExternalLink className="h-4 w-4" />Open contract document</a>}
            </div>
          </Section>

          <Section id="service" title="Service Details" description="What service is active and how long it remains active." icon={Landmark}>
            <div className="grid gap-5 md:grid-cols-4"><Field label="Service" value={onboarding?.service_name} /><Field label="Service duration" value={onboarding?.service_duration} /><Field label="Active until" value={formatDate(onboarding?.service_active_until)} /><Field label="Service status" value={contract.status} /><Field label="Service notes" value={onboarding?.service_notes} wide /></div>
          </Section>

          <Section id="team" title="Project Team / Assignment" description="Current and historical people assigned to the project." icon={Users}>
            {isAdmin && <AdminResourceManager resource="team" records={team} contractId={Number(contract.id)} onRefresh={refreshWorkspace} />}
            {!team.length ? <Empty>No project team members have been assigned yet.</Empty> : <div className="grid gap-3 md:grid-cols-2">{team.map((member: AnyRecord) => <div key={member.id} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><div className="flex items-start justify-between gap-3"><div><div className="font-semibold text-slate-900">{member.member_name}</div><div className="text-sm text-slate-500">{member.role || "Project team member"}</div></div><StatusPill value={member.is_current ? "Current" : "Past"} /></div><div className="mt-3 grid gap-2 text-sm sm:grid-cols-2"><Field label="Email" value={member.member_email} /><Field label="Department" value={member.department} /><Field label="Assignment start" value={formatDate(member.assignment_start_date)} /><Field label="Assignment end" value={formatDate(member.assignment_end_date)} /></div>{member.responsibilities && <p className="mt-3 whitespace-pre-wrap text-sm text-slate-500">{member.responsibilities}</p>}</div>)}</div>}
          </Section>

          <Section id="meetings" title="Meetings & MoM" description="First project meeting, discussion, minutes and action items." icon={Video}>
            {isAdmin && <AdminResourceManager resource="meetings" records={meetings} contractId={Number(contract.id)} onRefresh={refreshWorkspace} />}
            {!meetings.length ? <Empty>No project meetings have been recorded yet.</Empty> : <div className="space-y-3">{meetings.map((m: AnyRecord) => <div key={m.id} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><div className="font-semibold text-slate-900">{m.meeting_title}</div><div className="text-sm text-slate-500">{formatDateTime(m.meeting_date)} • {m.meeting_type || "Project Meeting"}</div><div className="mt-4 grid gap-4 md:grid-cols-2"><Field label="Participants" value={m.participants} /><Field label="Discussion" value={m.discussion} /><Field label="Minutes / MoM" value={m.minutes_of_meeting} wide /><Field label="Action items" value={m.action_items} wide /><Field label="Meeting notes location" value={m.notes_storage_url} wide /></div></div>)}</div>}
          </Section>

          <Section id="documents" title="Attachments / Documents" description="Agreement and other project documents." icon={Paperclip}>
            {isAdmin && <AdminResourceManager resource="documents" records={documents} contractId={Number(contract.id)} onRefresh={refreshWorkspace} />}
            {!documents.length ? <Empty>No client-visible documents have been uploaded yet.</Empty> : <div className="grid gap-3 md:grid-cols-2">{documents.map((doc: AnyRecord) => <div key={doc.id} className="flex items-center justify-between gap-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><div className="flex min-w-0 items-center gap-3"><div className="rounded-xl bg-sky-50 p-2 text-sky-600"><FileText className="h-5 w-5 shrink-0" /></div><div className="min-w-0"><div className="truncate font-medium text-slate-900">{doc.file_name}</div><div className="text-xs text-slate-500">{doc.document_type} • {formatDate(doc.created_at)}</div></div></div>{doc.file_url && <a href={doc.file_url} target="_blank" rel="noreferrer" className="shrink-0 text-sm font-medium text-blue-600 hover:underline">Open</a>}</div>)}</div>}
          </Section>

          <Section id="billing" title="Billing" description="Billing frequency, first cycle, next billing date and amount." icon={BadgeIndianRupee}>
            {isAdmin && <AdminResourceManager resource="billing" records={billing} contractId={Number(contract.id)} onRefresh={refreshWorkspace} />}
            {!billing.length ? <Empty>No billing cycle has been configured yet.</Empty> : <div className="grid gap-3 md:grid-cols-2">{billing.map((row: AnyRecord) => <div key={row.id} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><div className="flex items-center justify-between"><div className="font-semibold text-slate-900">{row.billing_cycle_name || "Billing cycle"}</div><StatusPill value={row.status} /></div><div className="mt-4 grid gap-4 sm:grid-cols-2"><Field label="Frequency" value={row.billing_frequency} /><Field label="Billing amount" value={money(row.billing_amount, row.currency)} /><Field label="First billing" value={formatDate(row.first_billing_date)} /><Field label="Next billing" value={formatDate(row.next_billing_date)} /><Field label="Cycle start" value={formatDate(row.cycle_start_date)} /><Field label="Cycle end" value={formatDate(row.cycle_end_date)} /></div></div>)}</div>}
          </Section>

          <Section id="invoices" title="Invoices" description="Invoice status, amount, due date and download location." icon={ReceiptIndianRupee}>
            {isAdmin && <AdminResourceManager resource="invoices" records={invoices} contractId={Number(contract.id)} onRefresh={refreshWorkspace} />}
            {!invoices.length ? <Empty>No invoices have been generated yet.</Empty> : <div className="overflow-x-auto rounded-2xl border border-slate-100 bg-white shadow-sm"><table className="w-full min-w-[860px] text-sm"><thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400"><tr><th className="px-4 py-3">Invoice</th><th className="px-4 py-3">Invoice date</th><th className="px-4 py-3">Due</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Generated</th><th className="px-4 py-3">Document</th>{!isAdmin && <th className="px-4 py-3">Pay</th>}</tr></thead><tbody>{invoices.map((row: AnyRecord) => <tr key={row.id} className="border-t border-slate-100"><td className="px-4 py-3 font-medium text-slate-900">{row.invoice_number}</td><td className="px-4 py-3 text-slate-600">{formatDate(row.invoice_date)}</td><td className="px-4 py-3 text-slate-600">{formatDate(row.due_date)}</td><td className="px-4 py-3 font-medium text-slate-900">{money(row.total_amount, row.currency)}</td><td className="px-4 py-3"><StatusPill value={row.status} /></td><td className="px-4 py-3">{row.generated_in_software ? <div><StatusPill value="Generated in software" />{row.generated_at && <div className="mt-1 text-xs text-slate-400">{formatDateTime(row.generated_at)}</div>}</div> : <span className="text-xs text-slate-400">Generated externally</span>}</td><td className="px-4 py-3">{row.invoice_url ? <a className="font-medium text-blue-600 hover:underline" href={row.invoice_url} target="_blank" rel="noreferrer">View / Download</a> : "—"}</td>{!isAdmin && <td className="px-4 py-3"><div className="flex flex-wrap gap-2">{String(row.status || "").toLowerCase() !== "paid" ? <><PayNowButton contractId={Number(contract.id)} invoice={row} onPaid={refreshWorkspace} /><Button size="sm" variant="outline" onClick={() => setReportingInvoice(row)}><Banknote className="mr-2 h-3.5 w-3.5" />Bank transfer</Button></> : <span className="text-xs text-slate-400">Paid</span>}</div></td>}</tr>)}</tbody></table></div>}
          </Section>

          <Section id="purchase-orders" title="Purchase Orders" description="PO number, issue date, amount and validity." icon={ShoppingCart}>
            {isAdmin && <AdminResourceManager resource="purchase_orders" records={purchaseOrders} contractId={Number(contract.id)} onRefresh={refreshWorkspace} />}
            {!purchaseOrders.length ? <Empty>No purchase order has been recorded yet.</Empty> : <div className="grid gap-3 md:grid-cols-2">{purchaseOrders.map((po: AnyRecord) => <div key={po.id} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><div className="flex items-center justify-between"><div className="font-semibold text-slate-900">{po.po_number}</div><StatusPill value={po.status} /></div><div className="mt-4 grid gap-4 sm:grid-cols-2"><Field label="PO issued" value={formatDate(po.issue_date)} /><Field label="PO amount" value={money(po.amount, po.currency)} /><Field label="Valid from" value={formatDate(po.validity_start_date)} /><Field label="Valid until" value={formatDate(po.validity_end_date)} /><Field label="PO document" value={po.po_document_url || "—"} wide /></div></div>)}</div>}
          </Section>

          <Section id="payments" title="Payments" description="Payment receipt, amount, account and payment status." icon={Wallet}>
            {isAdmin && <AdminBankAccountsManager />}
            {!isAdmin && <BankDetailsCard />}
            {isAdmin && <AdminResourceManager resource="payments" records={payments} contractId={Number(contract.id)} onRefresh={refreshWorkspace} />}
            {!payments.length ? <Empty>No payment has been recorded yet.</Empty> : <div className="grid gap-3 md:grid-cols-2">{payments.map((p: AnyRecord) => <div key={p.id} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><div className="flex items-center justify-between"><div className="font-semibold text-slate-900">{money(p.amount_received, p.currency)}</div><StatusPill value={p.payment_status} /></div><div className="mt-4 grid gap-4 sm:grid-cols-2"><Field label="Payment date" value={formatDate(p.payment_date)} /><Field label="Payment method" value={p.payment_method} /><Field label="Received account" value={p.received_account} /><Field label="Reference" value={p.payment_reference || p.transaction_reference} /><Field label="Receipt" value={p.receipt_url || "—"} wide /></div>{isAdmin && String(p.payment_status || "").toLowerCase() === "pending confirmation" && <PaymentConfirmActions contractId={Number(contract.id)} payment={p} onDone={refreshWorkspace} />}</div>)}</div>}
          </Section>

          <Section id="activity" title="Recent Activity" description="Audit trail for contract and project workspace changes." icon={Activity}>
            {!activity.length ? <Empty>No activity has been recorded yet.</Empty> : <div className="space-y-4">{activity.map((item: AnyRecord) => <div key={item.id} className="flex gap-3"><div className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-blue-600" /><div className="min-w-0"><div className="font-medium text-slate-900">{item.title}</div><div className="text-sm text-slate-500">{item.description}</div><div className="mt-1 text-xs text-slate-400">{item.actor_name || "System"} • {formatDateTime(item.created_at)}</div></div></div>)}</div>}
          </Section>
        </main>
      </div>

      {editing && (
        <Dialog open={editing} onOpenChange={setEditing}>
          <DialogContent className="max-h-[90vh] overflow-y-auto rounded-2xl sm:max-w-2xl">
            <DialogHeader><DialogTitle className="text-slate-900">{isAdmin ? "Edit complete onboarding / project information" : "Update permitted onboarding information"}</DialogTitle></DialogHeader>
            {isAdmin ? (
              <AdminOnboardingForm onboarding={onboarding} onSave={payload => saveOnboarding.mutate(payload)} pending={saveOnboarding.isPending} onCancel={() => setEditing(false)} />
            ) : (
              <div className="space-y-5">
                <div><Label className="text-slate-600">Initial project discussion date</Label><Input className="mt-2 rounded-xl border-slate-200" type="date" value={notes.initial_project_discussion_date} onChange={e => setNotes(x => ({...x, initial_project_discussion_date:e.target.value}))} /></div>
                <div><Label className="text-slate-600">Onboarding notes</Label><Textarea className="mt-2 min-h-28 rounded-xl border-slate-200" value={notes.onboarding_notes} onChange={e => setNotes(x => ({...x, onboarding_notes:e.target.value}))} /></div>
                <div><Label className="text-slate-600">Project notes</Label><Textarea className="mt-2 min-h-28 rounded-xl border-slate-200" value={notes.project_notes} onChange={e => setNotes(x => ({...x, project_notes:e.target.value}))} /></div>
                <div><Label className="text-slate-600">Service notes</Label><Textarea className="mt-2 min-h-28 rounded-xl border-slate-200" value={notes.service_notes} onChange={e => setNotes(x => ({...x, service_notes:e.target.value}))} /></div>
                <div className="flex justify-end gap-2"><Button variant="outline" className="rounded-xl border-slate-200" onClick={() => setEditing(false)}>Cancel</Button><Button className="rounded-xl bg-blue-600 hover:bg-blue-700" onClick={() => api(`/api/client/contracts/${contract.id}/onboarding`, {method:"PUT", body:JSON.stringify(notes)}).then(() => {toast.success("Saved."); setEditing(false); refreshWorkspace();}).catch((e:Error)=>toast.error(e.message))}>Save</Button></div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}

      {contractEditing && <ContractDialog open={contractEditing} onOpenChange={setContractEditing} contract={contract} pending={saveContract.isPending} onSave={v => saveContract.mutate(v)} />}

      {reportingInvoice && (
        <ReportBankTransferDialog
          open={Boolean(reportingInvoice)}
          onOpenChange={(v) => !v && setReportingInvoice(null)}
          contractId={Number(contract.id)}
          invoice={reportingInvoice}
          onReported={refreshWorkspace}
        />
      )}
    </div>
  );
}

function AdminOnboardingForm({ onboarding, onSave, pending, onCancel }: { onboarding: AnyRecord; onSave: (v: AnyRecord) => void; pending: boolean; onCancel: () => void }) {
  const [form, setForm] = useState<AnyRecord>({
    onboarding_status: onboarding?.onboarding_status || "Pending",
    onboarding_completed_at: onboarding?.onboarding_completed_at ? String(onboarding.onboarding_completed_at).slice(0,16) : "",
    onboarding_completed_by: onboarding?.onboarding_completed_by || "",
    onboarding_notes: onboarding?.onboarding_notes || "",
    project_start_date: onboarding?.project_start_date?.slice?.(0,10) || "",
    initial_project_discussion_date: onboarding?.initial_project_discussion_date?.slice?.(0,10) || "",
    project_status: onboarding?.project_status || "Not Started",
    current_phase: onboarding?.current_phase || "Requirement Analysis",
    progress_percent: onboarding?.progress_percent ?? 0,
    service_name: onboarding?.service_name || "",
    service_duration: onboarding?.service_duration || "",
    service_active_until: onboarding?.service_active_until?.slice?.(0,10) || "",
    service_notes: onboarding?.service_notes || "",
    project_notes: onboarding?.project_notes || "",
  });
  const set = (k:string,v:any) => setForm(x=>({...x,[k]:v}));
  return <div className="grid gap-4 md:grid-cols-2">
    <div><Label className="text-slate-600">Onboarding status</Label><Input className="mt-1 rounded-xl border-slate-200" value={form.onboarding_status} onChange={e=>set("onboarding_status",e.target.value)} /></div>
    <div><Label className="text-slate-600">Completed at</Label><Input className="mt-1 rounded-xl border-slate-200" type="datetime-local" value={form.onboarding_completed_at} onChange={e=>set("onboarding_completed_at",e.target.value)} /></div>
    <div><Label className="text-slate-600">Completed by</Label><Input className="mt-1 rounded-xl border-slate-200" value={form.onboarding_completed_by} onChange={e=>set("onboarding_completed_by",e.target.value)} /></div>
    <div><Label className="text-slate-600">Progress %</Label><Input className="mt-1 rounded-xl border-slate-200" type="number" min="0" max="100" value={form.progress_percent} onChange={e=>set("progress_percent",e.target.value)} /></div>
    <div><Label className="text-slate-600">Project start</Label><Input className="mt-1 rounded-xl border-slate-200" type="date" value={form.project_start_date} onChange={e=>set("project_start_date",e.target.value)} /></div>
    <div><Label className="text-slate-600">Initial project discussion</Label><Input className="mt-1 rounded-xl border-slate-200" type="date" value={form.initial_project_discussion_date} onChange={e=>set("initial_project_discussion_date",e.target.value)} /></div>
    <div><Label className="text-slate-600">Project status</Label><Input className="mt-1 rounded-xl border-slate-200" value={form.project_status} onChange={e=>set("project_status",e.target.value)} /></div>
    <div><Label className="text-slate-600">Current phase</Label><Input className="mt-1 rounded-xl border-slate-200" value={form.current_phase} onChange={e=>set("current_phase",e.target.value)} /></div>
    <div><Label className="text-slate-600">Service</Label><Input className="mt-1 rounded-xl border-slate-200" value={form.service_name} onChange={e=>set("service_name",e.target.value)} /></div>
    <div><Label className="text-slate-600">Service duration</Label><Input className="mt-1 rounded-xl border-slate-200" value={form.service_duration} onChange={e=>set("service_duration",e.target.value)} /></div>
    <div><Label className="text-slate-600">Service active until</Label><Input className="mt-1 rounded-xl border-slate-200" type="date" value={form.service_active_until} onChange={e=>set("service_active_until",e.target.value)} /></div>
    <div className="md:col-span-2"><Label className="text-slate-600">Onboarding notes</Label><Textarea className="mt-1 min-h-24 rounded-xl border-slate-200" value={form.onboarding_notes} onChange={e=>set("onboarding_notes",e.target.value)} /></div>
    <div className="md:col-span-2"><Label className="text-slate-600">Project notes</Label><Textarea className="mt-1 min-h-24 rounded-xl border-slate-200" value={form.project_notes} onChange={e=>set("project_notes",e.target.value)} /></div>
    <div className="md:col-span-2"><Label className="text-slate-600">Service notes</Label><Textarea className="mt-1 min-h-24 rounded-xl border-slate-200" value={form.service_notes} onChange={e=>set("service_notes",e.target.value)} /></div>
    <div className="md:col-span-2 flex justify-end gap-2"><Button variant="outline" className="rounded-xl border-slate-200" onClick={onCancel}>Cancel</Button><Button className="rounded-xl bg-blue-600 hover:bg-blue-700" disabled={pending} onClick={()=>onSave(form)}>{pending ? "Saving…" : "Save onboarding"}</Button></div>
  </div>;
}

function ContractDialog({ open, onOpenChange, contract, onSave, pending }: { open:boolean; onOpenChange:(v:boolean)=>void; contract:AnyRecord; onSave:(v:AnyRecord)=>void; pending:boolean }) {
  const [form,setForm]=useState({
    client_company_name: contract?.client_company_name || "",
    contract_title: contract?.contract_title || "",
    status: contract?.status || "active",
    start_date: contract?.start_date?.slice?.(0,10) || "",
    end_date: contract?.end_date?.slice?.(0,10) || "",
    total_duration: contract?.total_duration || "",
    services_covered: contract?.services_covered || "",
    contract_value: contract?.contract_value ?? 0,
    currency: contract?.currency || "INR",
    contract_document_url: contract?.contract_document_url || "",
    notes: contract?.notes || "",
  });
  const set=(k:string,v:any)=>setForm(x=>({...x,[k]:v}));
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90vh] overflow-y-auto rounded-2xl sm:max-w-2xl"><DialogHeader><DialogTitle className="text-slate-900">Edit Agreement / Contract</DialogTitle></DialogHeader><div className="grid gap-4 md:grid-cols-2">
    <div><Label className="text-slate-600">Client / company</Label><Input className="mt-1 rounded-xl border-slate-200" value={form.client_company_name} onChange={e=>set("client_company_name",e.target.value)} /></div>
    <div><Label className="text-slate-600">Contract title</Label><Input className="mt-1 rounded-xl border-slate-200" value={form.contract_title} onChange={e=>set("contract_title",e.target.value)} /></div>
    <div><Label className="text-slate-600">Status</Label><Input className="mt-1 rounded-xl border-slate-200" value={form.status} onChange={e=>set("status",e.target.value)} /></div>
    <div><Label className="text-slate-600">Currency</Label><Input className="mt-1 rounded-xl border-slate-200" value={form.currency} onChange={e=>set("currency",e.target.value)} /></div>
    <div><Label className="text-slate-600">Agreement start</Label><Input className="mt-1 rounded-xl border-slate-200" type="date" value={form.start_date} onChange={e=>set("start_date",e.target.value)} /></div>
    <div><Label className="text-slate-600">Agreement end</Label><Input className="mt-1 rounded-xl border-slate-200" type="date" value={form.end_date} onChange={e=>set("end_date",e.target.value)} /></div>
    <div><Label className="text-slate-600">Total duration</Label><Input className="mt-1 rounded-xl border-slate-200" value={form.total_duration} onChange={e=>set("total_duration",e.target.value)} /></div>
    <div><Label className="text-slate-600">Contract value</Label><Input className="mt-1 rounded-xl border-slate-200" type="number" value={form.contract_value} onChange={e=>set("contract_value",e.target.value)} /></div>
    <div className="md:col-span-2"><Label className="text-slate-600">Services covered</Label><Textarea className="mt-1 rounded-xl border-slate-200" value={form.services_covered} onChange={e=>set("services_covered",e.target.value)} /></div>
    <div className="md:col-span-2"><Label className="text-slate-600">Contract document URL</Label><Input className="mt-1 rounded-xl border-slate-200" value={form.contract_document_url} onChange={e=>set("contract_document_url",e.target.value)} /></div>
    <div className="md:col-span-2"><Label className="text-slate-600">Notes</Label><Textarea className="mt-1 rounded-xl border-slate-200" value={form.notes} onChange={e=>set("notes",e.target.value)} /></div>
  </div><DialogFooter><Button variant="outline" className="rounded-xl border-slate-200" onClick={()=>onOpenChange(false)}>Cancel</Button><Button className="rounded-xl bg-blue-600 hover:bg-blue-700" disabled={pending} onClick={()=>onSave(form)}>{pending?"Saving…":"Save contract"}</Button></DialogFooter></DialogContent></Dialog>;
}

function AdminEmptyState({ users, onRefresh }: { users: AnyRecord[]; onRefresh:()=>void }) {
  return <div className="p-6"><Card className="mx-auto max-w-3xl rounded-2xl p-8 shadow-sm"><div className="flex items-start gap-4"><div className="rounded-xl bg-blue-50 p-2 text-blue-600"><Users className="h-6 w-6" /></div><div><h1 className="text-2xl font-bold text-slate-900">Client Onboarding Control Center</h1><p className="mt-2 text-sm text-slate-500">No contracts are assigned yet. {users.length} login user(s) are available.</p><div className="mt-5 flex gap-2"><Button className="rounded-xl bg-blue-600 hover:bg-blue-700" onClick={()=>window.location.assign("/client-contracts")}>Assign a contract</Button><Button variant="outline" className="rounded-xl border-slate-200" onClick={onRefresh}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button></div></div></div></Card></div>;
}
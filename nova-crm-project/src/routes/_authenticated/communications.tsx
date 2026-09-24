import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader, EmptyState, StatCard } from "@/components/PageBits";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Phone, Mail, Calendar, MessageSquare, StickyNote, Search, CheckCircle2, Pencil, Trash2, ArrowDownLeft, ArrowUpRight, Clock, AlertTriangle, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { takePendingProposalEmail } from "@/lib/pendingProposalEmail";
import { api } from "@/lib/auth";
import { EmailTemplateEditor } from "@/components/EmailTemplateEditor";

export const Route = createFileRoute("/_authenticated/communications")({
  head: () => ({ meta: [{ title: "Communications — Nova CRM" }, { name: "description", content: "Log calls, emails, meetings and follow-ups." }] }),
  component: Communications,
});

const TYPES = [
  { key: "call", label: "Call", icon: Phone },
  { key: "email", label: "Email", icon: Mail },
  { key: "meeting", label: "Meeting", icon: Calendar },
  { key: "sms", label: "SMS", icon: MessageSquare },
  { key: "note", label: "Note", icon: StickyNote },
];

function iconFor(t: string) { return TYPES.find((x) => x.key === t)?.icon ?? StickyNote; }

// The activity list stores full HTML for email bodies (see
// /api/communications/send), so dumping a.body straight into the card
// shows raw markup instead of a message. This strips tags/entities and
// collapses whitespace so the list shows a short, readable one-line
// preview; the full formatted email is shown separately in a dialog when
// the person clicks the card (see MessagePreviewDialog below).
function toPlainTextPreview(html: string, maxLength = 160) {
  const text = String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|tr|td|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}…` : text;
}

// Not every activity body is HTML (calls/notes are already plain text) —
// this is a light heuristic so plain notes don't get mangled by the
// stripper above and short bodies don't get a pointless "view full
// message" affordance.
function looksLikeHtml(value: string) {
  return /<\/?[a-z][\s\S]*>/i.test(String(value || ""));
}

const emptyForm = { type: "call", subject: "", body: "", customer_id: "", direction: "outbound", status: "completed", due_at: "", duration_minutes: "" };

// Used only if /emailtemplates/index.json can't be fetched (see the
// emailTemplates query below). Paths point at "/emailtemplates/" — the
// actual folder name on disk (public/emailtemplates, no hyphen) — so these
// still resolve even without an index.json present.
const DEFAULT_EMAIL_TEMPLATES = [
  {
    id: "initial-introduction",
    name: "Initial Introduction",
    path: "/emailtemplates/initial-introduction.html",
    defaultSubject: "Introduction — OrbitAvanya Tech LLP",
  },
  {
    id: "company-introduction",
    name: "Company Introduction",
    path: "/emailtemplates/company-introduction.html",
    defaultSubject: "Company Introduction — OrbitAvanya Tech LLP",
  },
  {
    id: "personalized-outreach",
    name: "Personalized Outreach",
    path: "/emailtemplates/personalized-outreach.html",
    defaultSubject: "A Quick Note From OrbitAvanya Tech LLP",
  },
  {
    id: "service-oriented-introduction",
    name: "Service-Oriented Introduction",
    path: "/emailtemplates/service-oriented-introduction.html",
    defaultSubject: "Partnering With OrbitAvanya Tech LLP",
  },
  {
    id: "business-introduction",
    name: "Business Introduction",
    path: "/emailtemplates/business-introduction.html",
    defaultSubject: "Introduction — OrbitAvanya Tech LLP",
  },
  {
    id: "cloud-devops-introduction",
    name: "Cloud & DevOps",
    path: "/emailtemplates/cloud-devops-introduction.html",
    defaultSubject: "Cloud & DevOps Support — OrbitAvanya Tech LLP",
  },
  {
    id: "database-administration-introduction",
    name: "Database Administration",
    path: "/emailtemplates/database-administration-introduction.html",
    defaultSubject: "Database Administration & Migration — OrbitAvanya Tech LLP",
  },
  {
    id: "ai-solutions-introduction",
    name: "AI Solutions",
    path: "/emailtemplates/ai-solutions-introduction.html",
    defaultSubject: "Practical AI Solutions — OrbitAvanya Tech LLP",
  },
  {
    id: "dedicated-resources-introduction",
    name: "Dedicated Resources",
    path: "/emailtemplates/dedicated-resources-introduction.html",
    defaultSubject: "Extend Your Team With Dedicated Engineers — OrbitAvanya Tech LLP",
  },
  {
    id: "custom-software-introduction",
    name: "Custom Software Development",
    path: "/emailtemplates/custom-software-introduction.html",
    defaultSubject: "Custom Software Development — OrbitAvanya Tech LLP",
  },
];

type CommsSummary = {
  total: number;
  this_week: number;
  upcoming_followups: number;
  overdue_followups: number;
  by_type: { type: string; count: number }[];
};

// A generated proposal PDF kept in Storage (Proposals > Storage). The
// proposals page writes these to the browser's IndexedDB; this page only
// reads them, so each selected company's own proposal can be attached to
// its own email. KEEP IN SYNC with proposals.tsx (same DB / store / schema).
type StoredProposal = {
  id: string;
  proposal_id: number | null;
  proposal_number: string;
  filename: string;
  // Same id format as emailCompanies below: customer-12, tender-7,
  // software-live-3, digitization-sub-9 …
  company_key: string;
  company_name: string;
  contact_name: string;
  email: string;
  source_label: string;
  template_name: string;
  opportunity: string;
  created_at: string;
  sent_at: string | null;
  size: number;
  blob: Blob;
};

const PROPOSAL_DB_NAME = "orbitavanya-crm";
const PROPOSAL_DB_VERSION = 1;
const PROPOSAL_STORE = "stored_proposals";

function openProposalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser does not support local proposal storage."));
      return;
    }
    const request = indexedDB.open(PROPOSAL_DB_NAME, PROPOSAL_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PROPOSAL_STORE)) {
        request.result.createObjectStore(PROPOSAL_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open proposal storage."));
  });
}

async function listStoredProposals(): Promise<StoredProposal[]> {
  const db = await openProposalDb();
  try {
    const rows = await new Promise<StoredProposal[]>((resolve, reject) => {
      const tx = db.transaction(PROPOSAL_STORE, "readonly");
      const request = tx.objectStore(PROPOSAL_STORE).getAll();
      tx.oncomplete = () => resolve(request.result as StoredProposal[]);
      tx.onerror = () => reject(tx.error || new Error("Could not read proposal storage."));
      tx.onabort = () => reject(tx.error || new Error("Could not read proposal storage."));
    });
    return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  } finally {
    db.close();
  }
}

// Stamps sent_at on stored proposals after they were emailed, so the
// Storage tab can show which ones already went out.
async function markStoredProposalsSent(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await openProposalDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PROPOSAL_STORE, "readwrite");
      const store = tx.objectStore(PROPOSAL_STORE);
      const now = new Date().toISOString();
      ids.forEach((id) => {
        const request = store.get(id);
        request.onsuccess = () => {
          if (request.result) store.put({ ...request.result, sent_at: now });
        };
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Could not update proposal storage."));
      tx.onabort = () => reject(tx.error || new Error("Could not update proposal storage."));
    });
  } finally {
    db.close();
  }
}

function Communications() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(emptyForm);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [tab, setTab] = useState<"all" | "followups">("all");
  const [sendOpen, setSendOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [viewingActivity, setViewingActivity] = useState<any>(null);
  const [sendForm, setSendForm] = useState({
    mode: "manual" as "manual" | "customers",
    recipient_email: "",
    recipient_name: "",
    company_name: "",
    customer_ids: [] as string[],
    template_id: "",
    proposal_ids: [] as string[],
    subject: "",
    body: "",
  });
  const [emailAttachment, setEmailAttachment] = useState<File | null>(null);
  const emailAttachmentInputRef = useRef<HTMLInputElement | null>(null);
  // In "Select customer companies" mode, each ticked company gets its own
  // stored proposal attached. Untick to send the single file chosen below
  // to everyone instead (the old behaviour).
  const [autoAttachProposals, setAutoAttachProposals] = useState(true);

  const syncReminders = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/communications/sync-reminders", { method: "POST" });
      if (!response.ok) throw new Error("Failed to sync reminders.");
      return (await response.json()).count as number;
    },
    onSuccess: (count) => {
      if (count > 0) {
        toast.info(`${count} follow-up reminder${count === 1 ? "" : "s"} sent to Notifications`);
        qc.invalidateQueries({ queryKey: ["notifications"] });
      }
    },
  });
  useEffect(() => { syncReminders.mutate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const pending = takePendingProposalEmail();
    if (!pending) return;
    setSendForm((current) => ({
      ...current,
      mode: "manual",
      recipient_email: pending.recipient_email || "",
      recipient_name: pending.recipient_name || "",
      company_name: pending.company_name || "",
      subject: pending.subject || current.subject,
    }));
    setEmailAttachment(pending.file);
    setSendOpen(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: acts = [] } = useQuery({
    queryKey: ["communications"],
    queryFn: async () => {
      const response = await fetch("/api/communications");
      if (!response.ok) throw new Error("Failed to load communications.");
      return (await response.json()) ?? [];
    },
    refetchInterval: 15000,
  });
  // NOTE: this stays unfiltered (all customers) because the "Log Activity"
  // form below also uses this list to attach a call/note/meeting to any
  // customer, not just ones selected for proposal. The email picker filters
  // down to selected_for_proposal === true itself, in emailCompanies below.
  const { data: customers = [] } = useQuery({
    queryKey: ["customers-mini"],
    queryFn: async () => {
      const response = await fetch("/api/customers");
      if (!response.ok) throw new Error("Failed to load customers.");
      return (await response.json()) ?? [];
    },
  });

  // Same rule, for the Tender Customers module. Wrapped in try/catch so a
  // 403 for non-manager roles just leaves this list empty instead of
  // breaking the whole Send Email dialog.
  const { data: tenderCustomers = [] } = useQuery({
    queryKey: ["tender-customers-mini", "selected"],
    queryFn: async () => {
      try {
        const data = await api("/api/tender/customers?selected=true&limit=500");
        return data?.customers ?? [];
      } catch (err) {
        console.error(err);
        return [];
      }
    },
  });
  const { data: proposals = [] } = useQuery({
    queryKey: ["proposal-files-for-email"],
    queryFn: async () => {
      const response = await fetch("/api/proposals");
      if (!response.ok) throw new Error("Failed to load proposal files.");
      return (await response.json()) ?? [];
    },
  });

  // PDFs generated on Proposals > Generate and kept in Proposals > Storage.
  // Wrapped in try/catch so a browser without IndexedDB (or a blocked one)
  // just means "no stored proposals" instead of breaking the Send dialog.
  const { data: storedProposals = [] } = useQuery({
    queryKey: ["stored-proposals"],
    queryFn: async (): Promise<StoredProposal[]> => {
      try {
        return await listStoredProposals();
      } catch (err) {
        console.error(err);
        return [];
      }
    },
  });

  // company picker id -> that company's newest stored proposal.
  const proposalByCompany = useMemo(() => {
    const map = new Map<string, StoredProposal>();
    storedProposals.forEach((proposal) => {
      const current = map.get(proposal.company_key);
      if (!current || proposal.created_at > current.created_at) map.set(proposal.company_key, proposal);
    });
    return map;
  }, [storedProposals]);

  // Same rule as customers/tenderCustomers above, for the two SAM Data
  // modules (Software / Application and Scanning & Digitization). Each
  // module has its own live + subcontracting table; both are read and
  // filtered down to selected_for_proposal === true here, same as the
  // Proposals page does. Wrapped in try/catch so a module that hasn't
  // been scanned yet just contributes an empty list.
  const loadSamModule = async (module: "software" | "digitization") => {
    const [live, sub] = await Promise.all([
      api(`/api/${module}/live-tenders?limit=500`).catch(() => ({ tenders: [] })),
      api(`/api/${module}/subcontracting-tenders?limit=500`).catch(() => ({ tenders: [] })),
    ]);
    const keep = (rows: any[]) => (rows || []).filter((r: any) => r?.selected_for_proposal);
    return { live: keep((live as any)?.tenders), subcontracting: keep((sub as any)?.tenders) };
  };

  const { data: softwareTenders = { live: [], subcontracting: [] } } = useQuery({
    queryKey: ["software-tenders-mini", "selected"],
    queryFn: () => loadSamModule("software"),
  });

  const { data: digitizationTenders = { live: [], subcontracting: [] } } = useQuery({
    queryKey: ["digitization-tenders-mini", "selected"],
    queryFn: () => loadSamModule("digitization"),
  });

  const { data: emailTemplates = [] } = useQuery({
    queryKey: ["email-templates"],
    queryFn: async () => {
      // Same "/email-templates/" vs "/emailtemplates/" resilience as
      // fetchTemplateHtml below — try the hyphenated path first, then the
      // real on-disk folder name, and only fall back to the hardcoded list
      // if neither index.json can be found.
      for (const indexPath of ["/email-templates/index.json", "/emailtemplates/index.json"]) {
        try {
          const response = await fetch(indexPath);
          if (response.ok) {
            const data = await response.json();
            const list = Array.isArray(data) ? data : (data.templates || []);
            if (list.length) return list;
          }
        } catch {
          // try the next candidate path
        }
      }
      return DEFAULT_EMAIL_TEMPLATES;
    },
  });

  const { data: summary } = useQuery({
    queryKey: ["communications-summary"],
    queryFn: async () => {
      const response = await fetch("/api/communications/summary");
      if (!response.ok) throw new Error("Failed to load communications summary.");
      return (await response.json()) as CommsSummary;
    },
    refetchInterval: 15000,
  });

  const resetForm = () => { setForm(emptyForm); setEditing(null); };

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        type: form.type, subject: form.subject, body: form.body, customer_id: form.customer_id || null,
        direction: form.direction, status: form.status,
        due_at: form.status === "scheduled" && form.due_at ? new Date(form.due_at).toISOString() : null,
        duration_minutes: form.duration_minutes ? Number(form.duration_minutes) : null,
        ...(form.status !== "scheduled" ? { notified: false } : {}),
      };
      const response = await fetch(editing ? `/api/activities/${editing.id}` : "/api/activities", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || "Failed to save activity.");
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Updated" : "Logged");
      setOpen(false);
      resetForm();
      qc.invalidateQueries({ queryKey: ["communications"] });
      qc.invalidateQueries({ queryKey: ["communications-summary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: async (item: any) => {
      const endpoint = item.source === "communication"
        ? `/api/communications/${item.id}`
        : `/api/activities/${item.id}`;
      const response = await fetch(endpoint, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || "Failed to remove item.");
    },
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["communications"] });
      qc.invalidateQueries({ queryKey: ["communications-summary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const complete = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/activities/${id}/complete`, { method: "PUT" });
      if (!response.ok) throw new Error("Failed to complete activity.");
    },
    onSuccess: () => {
      toast.success("Marked as done");
      qc.invalidateQueries({ queryKey: ["communications"] });
      qc.invalidateQueries({ queryKey: ["communications-summary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resetSendForm = () => {
    setSendForm({
      mode: "manual",
      recipient_email: "",
      recipient_name: "",
      company_name: "",
      customer_ids: [],
      template_id: "",
      proposal_ids: [],
      subject: "",
      body: "",
    });
    setEmailAttachment(null);
    setAutoAttachProposals(true);
    if (emailAttachmentInputRef.current) emailAttachmentInputRef.current.value = "";
  };

  // Fetches a template's HTML from disk. Tries the given path first, then
  // falls back to a non-hyphenated "/emailtemplates/..." variant in case the
  // public folder on disk isn't named exactly "email-templates". This makes
  // template loading resilient to that one naming detail instead of failing
  // outright, and the thrown error reports every path/status it tried so the
  // real folder name can be confirmed from the error toast if both fail.
  const fetchTemplateHtml = async (primaryPath: string): Promise<string> => {
    const candidates = [primaryPath];
    if (primaryPath.includes("/email-templates/")) {
      candidates.push(primaryPath.replace("/email-templates/", "/emailtemplates/"));
    }

    const attempts: string[] = [];
    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate);
        if (response.ok) return await response.text();
        attempts.push(`${candidate} (HTTP ${response.status})`);
      } catch (fetchErr: any) {
        attempts.push(`${candidate} (${fetchErr?.message || "network error"})`);
      }
    }

    throw new Error(`Template file could not be loaded. Tried: ${attempts.join(", ")}`);
  };

  const applyTemplate = async (templateId: string) => {
    // Deselecting keeps the current message editable as custom HTML.
    if (!templateId) {
      setSendForm((current) => ({ ...current, template_id: "" }));
      return;
    }

    setSendForm((current) => ({ ...current, template_id: templateId }));
    const template = emailTemplates.find((item: any) => String(item.id) === templateId);
    if (!template?.path) return;

    try {
      const html = await fetchTemplateHtml(template.path);
      setSendForm((current) => ({
        ...current,
        template_id: templateId,
        subject: current.subject || template.defaultSubject || "",
        body: html,
      }));
    } catch (e: any) {
      toast.error(e.message || "Failed to load email template.");
    }
  };

  // Combined, normalized list for the "Select customer companies" picker —
  // only companies marked "selected for proposal" from any of the four
  // pages (Customers, Tender Customers, Software / Application, Scanning &
  // Digitization) show up here. Ids are prefixed per-source-and-table
  // (customer- / tender- / software-live- / software-sub- /
  // digitization-live- / digitization-sub-) so none of the six tables'
  // separate auto-increment ids can ever collide inside
  // sendForm.customer_ids, even if two tables happen to reuse the same
  // numeric id.
  const firstEmail = (value?: string) => {
    const match = String(value || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    return match ? match[0] : "";
  };

  const emailCompanies = useMemo(() => {
    const fromCustomers = customers
      .filter((c: any) => c.selected_for_proposal)
      .map((c: any) => ({
        id: `customer-${c.id}`,
        source: "customer" as const,
        source_label: "Customer",
        source_id: c.id,
        company_name: c.company_name,
        contact_name: c.contact_name || c.ceo_name || "",
        ceo_name: c.ceo_name || c.contact_name || "",
        email: firstEmail(c.email) || c.email || "",
      }));
    // Tender customers are fetched with ?selected=true already, so no
    // extra filter is needed for that half.
    const fromTender = tenderCustomers.map((t: any) => ({
      id: `tender-${t.id}`,
      source: "tender" as const,
      source_label: "Tender",
      source_id: t.id,
      company_name: t.company_name,
      contact_name: t.executive_name || "",
      ceo_name: t.executive_name || "",
      email: firstEmail(t.executive_email) || firstEmail(t.company_emails) || "",
    }));
    // Live tender rows: the "contact" is the buyer / contracting officer.
    const fromSamLive = (module: "software" | "digitization", rows: any[]) =>
      rows.map((r: any) => ({
        id: `${module}-live-${r.id}`,
        source: module,
        source_label: module === "software" ? "Software (Live)" : "Digitization (Live)",
        source_id: r.id,
        company_name: r.company_name || r.agency || r.tender_title || "Untitled tender",
        contact_name: r.buyer_contact_name || "",
        ceo_name: r.buyer_contact_name || "",
        email: firstEmail(r.buyer_contact_email) || firstEmail(r.contracting_officer_contact) || "",
      }));
    // Subcontracting / prospect rows: the "contact" is the prime contractor.
    const fromSamSub = (module: "software" | "digitization", rows: any[]) =>
      rows.map((r: any) => ({
        id: `${module}-sub-${r.id}`,
        source: module,
        source_label: module === "software" ? "Software (Subcontracting)" : "Digitization (Subcontracting)",
        source_id: r.id,
        company_name: r.prime_contractor || r.company_name || r.legal_company_name || "Untitled company",
        contact_name: (r.executive_names_and_roles || "").split(/[,;|\n]/)[0]?.split(/\s+[-–—]\s+/)[0] || "",
        ceo_name: (r.executive_names_and_roles || "").split(/[,;|\n]/)[0]?.split(/\s+[-–—]\s+/)[0] || "",
        email: firstEmail(r.executive_emails) || firstEmail(r.procurement_emails) || firstEmail(r.company_emails) || "",
      }));
    return [
      ...fromCustomers,
      ...fromTender,
      ...fromSamLive("software", softwareTenders.live),
      ...fromSamSub("software", softwareTenders.subcontracting),
      ...fromSamLive("digitization", digitizationTenders.live),
      ...fromSamSub("digitization", digitizationTenders.subcontracting),
    ];
  }, [customers, tenderCustomers, softwareTenders, digitizationTenders]);

  const selectedCustomers = emailCompanies.filter((company) =>
    sendForm.customer_ids.includes(company.id)
  );

  const toggleCustomer = (id: string) => {
    setSendForm((current) => ({
      ...current,
      customer_ids: current.customer_ids.includes(id)
        ? current.customer_ids.filter((value) => value !== id)
        : [...current.customer_ids, id],
    }));
  };

  // Ticked companies that can actually be emailed, split by whether a
  // stored proposal exists for them.
  const emailableSelected = selectedCustomers.filter((company) => company.email);
  const selectedWithProposal = emailableSelected.filter((company) => proposalByCompany.has(company.id));
  const selectedWithoutProposal = emailableSelected.filter((company) => !proposalByCompany.has(company.id));

  const companiesWithProposal = emailCompanies.filter(
    (company) => company.email && proposalByCompany.has(company.id)
  );

  const selectAllWithProposals = () => {
    const ids = companiesWithProposal.map((company) => company.id);
    setSendForm((current) => ({
      ...current,
      customer_ids: Array.from(new Set([...current.customer_ids, ...ids])),
    }));
  };

  const toggleProposal = (id: string) => {
    setSendForm((current) => ({
      ...current,
      proposal_ids: current.proposal_ids.includes(id)
        ? current.proposal_ids.filter((value) => value !== id)
        : [...current.proposal_ids, id],
    }));
  };

  const sendEmail = useMutation({
    mutationFn: async () => {
      // If a template is selected but the message box is empty, fall back
      // to the template's own HTML so "template selected + empty message"
      // still sends real content instead of nothing.
      let effectiveBody = sendForm.body;
      if (sendForm.template_id && !effectiveBody.trim()) {
        const template = emailTemplates.find((item: any) => String(item.id) === sendForm.template_id);
        if (template?.path) {
          effectiveBody = await fetchTemplateHtml(template.path);
        }
      }
      if (!effectiveBody || !effectiveBody.trim()) {
        throw new Error("Message body is required.");
      }

      type Recipient = {
        recipient_email: string;
        recipient_name: string;
        company_name: string;
        ceo_name: string;
        customer_id: number | null;
      };
      type SendResult = { sent_count: number; failed_count: number; problems: string[] };

      // One entry per email to send: the recipient, plus (company mode) that
      // company's own stored proposal when auto-attach is on.
      const targets: { recipient: Recipient; stored: StoredProposal | null }[] =
        sendForm.mode === "customers"
          ? emailableSelected.map((company) => ({
              recipient: {
                recipient_email: company.email,
                recipient_name: company.contact_name || company.ceo_name || "",
                company_name: company.company_name || "",
                ceo_name: company.ceo_name || company.contact_name || "",
                // Only real CRM customers link back to a customers.id row —
                // tender companies live in a separate table, so this stays
                // null for them rather than risk pointing at an unrelated
                // customer record that happens to share the same numeric id.
                customer_id: company.source === "customer" ? company.source_id : null,
              },
              stored: autoAttachProposals ? proposalByCompany.get(company.id) ?? null : null,
            }))
          : [{
              recipient: {
                recipient_email: sendForm.recipient_email,
                recipient_name: sendForm.recipient_name,
                company_name: sendForm.company_name,
                ceo_name: sendForm.recipient_name,
                customer_id: null,
              },
              stored: null,
            }];

      if (!targets.length) {
        throw new Error("Select at least one customer with an email address.");
      }

      // One /api/communications/send request. The endpoint attaches a single
      // file per request, so recipients that need different attachments have
      // to be sent in separate requests.
      const postSend = async (recipients: Recipient[], file: File | null): Promise<SendResult> => {
        const payload = new FormData();
        payload.append("recipients", JSON.stringify(recipients));
        payload.append("subject", sendForm.subject);
        payload.append("body", effectiveBody);
        payload.append("proposal_ids", JSON.stringify(sendForm.proposal_ids.map(Number)));
        if (file) payload.append("attachment", file);

        const response = await fetch("/api/communications/send", {
          method: "POST",
          body: payload,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok && response.status !== 207) {
          throw new Error(data.message || "Failed to send email.");
        }
        return {
          sent_count: Number(data.sent_count) || recipients.length,
          failed_count: Number(data.failed_count) || 0,
          problems: Array.isArray(data.failures)
            ? data.failures.map((f: any) => `${f.email}: ${f.message}`)
            : [],
        };
      };

      const withOwnProposal = targets.filter((target) => target.stored);

      // Nobody has their own proposal: a single request with the shared
      // attachment (if any) — exactly how this dialog always worked.
      if (!withOwnProposal.length) {
        return postSend(targets.map((target) => target.recipient), emailAttachment);
      }

      let sent = 0;
      let failed = 0;
      const problems: string[] = [];
      const sentProposalIds: string[] = [];

      // Each company with a stored proposal: its own email + its own PDF.
      for (const { recipient, stored } of withOwnProposal) {
        try {
          const file = new File([stored!.blob], stored!.filename, { type: "application/pdf" });
          const result = await postSend([recipient], file);
          sent += result.sent_count;
          failed += result.failed_count;
          problems.push(...result.problems);
          sentProposalIds.push(stored!.id);
        } catch (err: any) {
          failed += 1;
          problems.push(`${recipient.company_name || recipient.recipient_email}: ${err?.message || "Failed to send."}`);
        }
      }

      // Companies without one share a single request, carrying the file
      // chosen in the dialog (if any).
      const withoutOwnProposal = targets
        .filter((target) => !target.stored)
        .map((target) => target.recipient);
      if (withoutOwnProposal.length) {
        try {
          const result = await postSend(withoutOwnProposal, emailAttachment);
          sent += result.sent_count;
          failed += result.failed_count;
          problems.push(...result.problems);
        } catch (err: any) {
          failed += withoutOwnProposal.length;
          problems.push(err?.message || "Failed to send email.");
        }
      }

      // Best effort — a storage hiccup must not turn a sent email into an error.
      await markStoredProposalsSent(sentProposalIds).catch(() => undefined);

      if (sent === 0) {
        throw new Error(problems[0] || "No emails were sent.");
      }
      return { sent_count: sent, failed_count: failed, problems };
    },
    onSuccess: (data) => {
      if (data.failed_count) {
        toast.warning(
          `${data.sent_count} email(s) sent, ${data.failed_count} failed.`,
          data.problems.length ? { description: data.problems.slice(0, 3).join(" • ") } : undefined
        );
      } else {
        toast.success(`${data.sent_count || 1} email(s) sent successfully.`);
      }
      setSendOpen(false);
      resetSendForm();
      qc.invalidateQueries({ queryKey: ["communications"] });
      qc.invalidateQueries({ queryKey: ["communications-summary"] });
      qc.invalidateQueries({ queryKey: ["stored-proposals"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Guards against a half-attached bulk send: if some ticked companies have
  // a stored proposal and others don't (and no shared file was chosen), the
  // second group would silently go out with nothing attached.
  const handleSendClick = () => {
    if (
      sendForm.mode === "customers" &&
      autoAttachProposals &&
      !emailAttachment &&
      selectedWithProposal.length > 0 &&
      selectedWithoutProposal.length > 0
    ) {
      const names = selectedWithoutProposal.slice(0, 5).map((company) => company.company_name).join(", ");
      const more = selectedWithoutProposal.length > 5 ? ` and ${selectedWithoutProposal.length - 5} more` : "";
      const ok = window.confirm(
        `${selectedWithoutProposal.length} of the ${emailableSelected.length} selected companies have no stored proposal ` +
          `and will be sent WITHOUT an attachment:\n\n${names}${more}\n\nSend anyway?`
      );
      if (!ok) return;
    }
    sendEmail.mutate();
  };

  const openEdit = (a: any) => {
    if (a.source === "communication") {
      toast.info("Received emails are read-only here. Use the email/customer record for details.");
      return;
    }
    setEditing(a);
    setForm({
      type: a.type, subject: a.subject ?? "", body: a.body ?? "", customer_id: a.customer_id ?? "",
      direction: a.direction ?? "outbound", status: a.status ?? "completed",
      due_at: a.due_at ? new Date(a.due_at).toISOString().slice(0, 16) : "",
      duration_minutes: a.duration_minutes ? String(a.duration_minutes) : "",
    });
    setOpen(true);
  };
  const openNew = () => { resetForm(); setOpen(true); };

  const filtered = useMemo(() => {
    return acts.filter((a: any) => {
      if (tab === "followups" && a.status !== "scheduled") return false;
      if (typeFilter !== "all" && a.type !== typeFilter) return false;
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return a.subject?.toLowerCase().includes(q) || a.body?.toLowerCase().includes(q) || a.customer_name?.toLowerCase().includes(q);
    });
  }, [acts, search, typeFilter, tab]);

  return (
    <div>
      <PageHeader
        title="Communications"
        description="Activity timeline, follow-ups, and reminders across calls, emails, and meetings."
        actions={
          <>
            <Dialog
              open={sendOpen}
              onOpenChange={(value) => {
                setSendOpen(value);
                if (!value) resetSendForm();
                else qc.invalidateQueries({ queryKey: ["stored-proposals"] });
              }}
            >
              <DialogTrigger asChild>
                <Button variant="outline">
                  <Mail className="mr-2 h-4 w-4" />
                  Send email
                </Button>
              </DialogTrigger>

              <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Send email</DialogTitle>
                </DialogHeader>

                <div className="grid gap-4">
                  <div className="grid grid-cols-2 gap-2 rounded-lg border border-border p-2">
                    <Button
                      type="button"
                      variant={sendForm.mode === "manual" ? "default" : "ghost"}
                      onClick={() => setSendForm((current) => ({ ...current, mode: "manual" }))}
                    >
                      Manual recipient
                    </Button>
                    <Button
                      type="button"
                      variant={sendForm.mode === "customers" ? "default" : "ghost"}
                      onClick={() => setSendForm((current) => ({ ...current, mode: "customers" }))}
                    >
                      Select customer companies
                    </Button>
                  </div>

                  {sendForm.mode === "manual" ? (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label>Recipient email *</Label>
                          <Input
                            value={sendForm.recipient_email}
                            onChange={(e) => setSendForm({ ...sendForm, recipient_email: e.target.value })}
                            placeholder="client@example.com"
                          />
                        </div>
                        <div>
                          <Label>Recipient name *</Label>
                          <Input
                            value={sendForm.recipient_name}
                            onChange={(e) => setSendForm({ ...sendForm, recipient_name: e.target.value })}
                            placeholder="CEO / contact name"
                          />
                        </div>
                      </div>

                      <div>
                        <Label>Company name *</Label>
                        <Input
                          value={sendForm.company_name}
                          onChange={(e) => setSendForm({ ...sendForm, company_name: e.target.value })}
                          placeholder="Company name"
                        />
                      </div>
                    </>
                  ) : (
                    <div>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <Label>Select one or multiple companies *</Label>
                        <span className="flex items-center gap-3 text-xs text-muted-foreground">
                          {companiesWithProposal.length > 0 && (
                            <button
                              type="button"
                              className="font-medium text-primary hover:underline"
                              onClick={selectAllWithProposals}
                            >
                              Select all with proposal ({companiesWithProposal.length})
                            </button>
                          )}
                          {selectedCustomers.length} selected
                        </span>
                      </div>
                      <div className="max-h-64 overflow-y-auto rounded-lg border border-border p-2">
                        {emailCompanies.map((company) => {
                          const checked = sendForm.customer_ids.includes(company.id);
                          const hasEmail = Boolean(company.email);
                          const ownProposal = proposalByCompany.get(company.id);
                          return (
                            <label
                              key={company.id}
                              className={`flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted ${
                                hasEmail ? "cursor-pointer" : "cursor-not-allowed opacity-60"
                              }`}
                            >
                              <span className="flex min-w-0 items-center gap-3">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={!hasEmail}
                                  title={hasEmail ? undefined : "No email address on this record."}
                                  onChange={() => hasEmail && toggleCustomer(company.id)}
                                />
                                <span className="min-w-0">
                                  <span className="block truncate font-medium">{company.company_name}</span>
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {company.contact_name || "No contact"} · {company.email || "No email"} ·{" "}
                                    {company.source_label}
                                  </span>
                                  {autoAttachProposals && ownProposal && (
                                    <span
                                      className="mt-0.5 flex items-center gap-1 text-xs text-emerald-600"
                                      title={`${ownProposal.proposal_number} — attaches automatically`}
                                    >
                                      <Paperclip className="h-3 w-3 shrink-0" />
                                      <span className="truncate">{ownProposal.filename}</span>
                                    </span>
                                  )}
                                  {autoAttachProposals &&
                                    !ownProposal &&
                                    checked &&
                                    selectedWithProposal.length > 0 && (
                                      <span className="mt-0.5 block text-xs text-amber-600">
                                        No stored proposal for this company
                                      </span>
                                    )}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                        {emailCompanies.length === 0 && (
                          <p className="p-2 text-sm text-muted-foreground">
                            No companies are selected for proposal yet. Go to Customers, Tender Customers,
                            Software / Application or Scanning &amp; Digitization, check the companies you
                            want, and click "Send to Proposals" / "Mark for proposal" first.
                          </p>
                        )}
                      </div>
                      {proposalByCompany.size > 0 && (
                        <div className="mt-2 space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
                          <label className="flex cursor-pointer items-center gap-2 font-medium">
                            <input
                              type="checkbox"
                              checked={autoAttachProposals}
                              onChange={(e) => setAutoAttachProposals(e.target.checked)}
                            />
                            Attach each company's own proposal automatically
                          </label>
                          {autoAttachProposals ? (
                            emailableSelected.length > 0 && (
                              <p className="text-muted-foreground">
                                {selectedWithProposal.length} of {emailableSelected.length} selected will get their
                                own proposal PDF, sent as a separate email each.
                                {selectedWithProposal.length > 0 && selectedWithoutProposal.length > 0 && (
                                  <>
                                    {" "}
                                    {emailAttachment
                                      ? `The other ${selectedWithoutProposal.length} will get the file chosen below.`
                                      : `The other ${selectedWithoutProposal.length} have no stored proposal and would go out without an attachment.`}
                                  </>
                                )}
                              </p>
                            )
                          ) : (
                            <p className="text-muted-foreground">
                              Off — the file chosen below (if any) is sent to every selected company.
                            </p>
                          )}
                        </div>
                      )}
                      {selectedCustomers.some((customer: any) => !customer.email) && (
                        <p className="mt-2 text-xs text-amber-600">
                          Customers without an email address are skipped automatically.
                        </p>
                      )}
                    </div>
                  )}

                  <div>
                    <Label>Email template</Label>
                    <div className="flex gap-2">
                      <Select
                        value={sendForm.template_id}
                        onValueChange={(value) => { void applyTemplate(value); }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select a template from public/emailtemplates" />
                        </SelectTrigger>
                        <SelectContent>
                          {emailTemplates.map((template: any) => (
                            <SelectItem key={String(template.id)} value={String(template.id)}>
                              {template.name || template.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {sendForm.template_id && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => { void applyTemplate(""); }}
                        >
                          Deselect
                        </Button>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Select a template or deselect it to continue with your own custom HTML message. Variables such as {"{{CEO_Name}}"} and {"{{Company_Name}}"} are replaced automatically for each recipient.
                    </p>
                  </div>

                  <div>
                    <Label>Subject *</Label>
                    <Input
                      value={sendForm.subject}
                      onChange={(e) => setSendForm({ ...sendForm, subject: e.target.value })}
                    />
                  </div>

                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <Label>Message *</Label>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">HTML template supported</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!sendForm.body.trim()}
                          onClick={() => setPreviewOpen(true)}
                        >
                          Preview &amp; edit
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      rows={12}
                      value={sendForm.body}
                      onChange={(e) => setSendForm({ ...sendForm, body: e.target.value })}
                    />
                    <EmailTemplateEditor
                      open={previewOpen}
                      onOpenChange={setPreviewOpen}
                      html={sendForm.body}
                      onApply={(newHtml) => setSendForm((current) => ({ ...current, body: newHtml }))}
                    />
                  </div>

                  <div>
                    <Label>Choose proposal/document from system files (optional)</Label>
                    <div className="mt-2 flex items-center gap-2">
                      <Input
                        ref={emailAttachmentInputRef}
                        type="file"
                        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,image/*"
                        onChange={(e) => setEmailAttachment(e.target.files?.[0] || null)}
                      />
                      {emailAttachment && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            setEmailAttachment(null);
                            if (emailAttachmentInputRef.current) emailAttachmentInputRef.current.value = "";
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {emailAttachment
                        ? `Selected: ${emailAttachment.name}`
                        : "Optional — choose a file from your computer, or send without an attachment."}
                    </p>
                  </div>
                </div>

                <DialogFooter>
                  <Button
                    onClick={handleSendClick}
                    disabled={
                      sendEmail.isPending ||
                      !sendForm.subject ||
                      (!sendForm.template_id && !sendForm.body) ||
                      (sendForm.mode === "manual"
                        ? !sendForm.recipient_email || !sendForm.recipient_name || !sendForm.company_name
                        : selectedCustomers.filter((customer: any) => customer.email).length === 0)
                    }
                    className="bg-gradient-primary shadow-glow"
                  >
                    {sendEmail.isPending ? "Sending…" : `Send ${sendForm.mode === "customers" ? `${selectedCustomers.filter((customer: any) => customer.email).length || ""} email${selectedCustomers.filter((customer: any) => customer.email).length === 1 ? "" : "s"}` : "email"}`}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog
              open={open}
              onOpenChange={(v) => {
                setOpen(v);
                if (!v) resetForm();
              }}
            >
              <DialogTrigger asChild>
                <Button
                  className="bg-gradient-primary shadow-glow"
                  onClick={openNew}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Log activity
                </Button>
              </DialogTrigger>

              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {editing ? "Edit activity" : "Log activity"}
                  </DialogTitle>
                </DialogHeader>

                <div className="grid gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Type</Label>

                      <Select
                        value={form.type}
                        onValueChange={(v) =>
                          setForm({
                            ...form,
                            type: v,
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>

                        <SelectContent>
                          {TYPES.map((t) => (
                            <SelectItem
                              key={t.key}
                              value={t.key}
                            >
                              {t.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label>Customer</Label>

                      <Select
                        value={form.customer_id}
                        onValueChange={(v) =>
                          setForm({
                            ...form,
                            customer_id: v,
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Optional" />
                        </SelectTrigger>

                        <SelectContent>
                          {customers.map((c: any) => (
                            <SelectItem
                              key={c.id}
                              value={String(c.id)}
                            >
                              {c.company_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Direction</Label>

                      <Select
                        value={form.direction}
                        onValueChange={(v) =>
                          setForm({
                            ...form,
                            direction: v,
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>

                        <SelectContent>
                          <SelectItem value="outbound">
                            Outbound
                          </SelectItem>

                          <SelectItem value="inbound">
                            Inbound
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <Label>Duration (min)</Label>

                      <Input
                        type="number"
                        value={form.duration_minutes}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            duration_minutes: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div>
                    <Label>Subject</Label>

                    <Input
                      value={form.subject}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          subject: e.target.value,
                        })
                      }
                    />
                  </div>

                  <div>
                    <Label>Details</Label>

                    <Textarea
                      rows={4}
                      value={form.body}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          body: e.target.value,
                        })
                      }
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3">
                    <div>
                      <Label>Status</Label>

                      <Select
                        value={form.status}
                        onValueChange={(v) =>
                          setForm({
                            ...form,
                            status: v,
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>

                        <SelectContent>
                          <SelectItem value="completed">
                            Completed
                          </SelectItem>

                          <SelectItem value="scheduled">
                            Scheduled follow-up
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {form.status === "scheduled" && (
                      <div>
                        <Label>Follow-up due</Label>

                        <Input
                          type="datetime-local"
                          value={form.due_at}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              due_at: e.target.value,
                            })
                          }
                        />
                      </div>
                    )}
                  </div>

                  {form.status === "scheduled" && (
                    <p className="-mt-2 text-xs text-muted-foreground">
                      A reminder notification is sent automatically once this
                      becomes due.
                    </p>
                  )}
                </div>

                <DialogFooter>
                  <Button
                    onClick={() => save.mutate()}
                    disabled={save.isPending}
                    className="bg-gradient-primary shadow-glow"
                  >
                    {editing ? "Save changes" : "Save"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Total logged" value={summary?.total ?? acts.length} />
        <StatCard label="This week" value={summary?.this_week ?? 0} />
        <StatCard label="Upcoming follow-ups" value={summary?.upcoming_followups ?? 0} />
        <StatCard label="Overdue follow-ups" value={summary?.overdue_followups ?? 0} hint={summary?.overdue_followups ? "Needs attention" : undefined} />
      </div>

      <div className="mt-6 mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-secondary/50 p-1">
          <button onClick={() => setTab("all")} className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${tab === "all" ? "bg-gradient-primary text-primary-foreground shadow-glow" : "text-muted-foreground hover:text-foreground"}`}>All activity</button>
          <button onClick={() => setTab("followups")} className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${tab === "followups" ? "bg-gradient-primary text-primary-foreground shadow-glow" : "text-muted-foreground hover:text-foreground"}`}>Follow-ups</button>
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search subject, notes, customer…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="All types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {TYPES.map((t) => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {acts.length === 0 ? (
        <EmptyState title="No activity yet" description="Log your first call, email, or meeting." />
      ) : filtered.length === 0 ? (
        <EmptyState title="No matches" description="Try a different search, type, or tab." />
      ) : (
        <div className="grid gap-3">
          {filtered.map((a: any) => {
            const Icon = iconFor(a.type);
            const overdue = a.status === "scheduled" && a.due_at && new Date(a.due_at) < new Date();
            return (
              <Card
                key={a.id}
                className={`glass group flex items-start gap-4 p-4 transition-shadow hover:shadow-glow ${overdue ? "border-destructive/40" : ""} ${a.body ? "cursor-pointer" : ""}`}
                onClick={() => a.body && setViewingActivity(a)}
              >
                <div className="mt-1 rounded-lg bg-gradient-primary p-2 shadow-glow"><Icon className="h-4 w-4 text-primary-foreground" /></div>
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{a.type}</Badge>
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      {a.direction === "inbound" ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                      {a.direction}
                    </span>
                    <span className="font-medium">{a.subject || "Untitled"}</span>
                    {a.customer_name && <span className="text-xs text-muted-foreground">· {a.customer_name}</span>}
                    {a.duration_minutes ? <span className="text-xs text-muted-foreground">· {a.duration_minutes}m</span> : null}
                    {a.status === "scheduled" && (
                      <Badge variant={overdue ? "destructive" : "outline"} className="ml-auto flex items-center gap-1">
                        {overdue ? <AlertTriangle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                        {overdue ? "Overdue" : "Follow-up"} · {a.due_at && new Date(a.due_at).toLocaleString()}
                      </Badge>
                    )}
                  </div>
                  {a.body && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {looksLikeHtml(a.body) ? toPlainTextPreview(a.body) : a.body}
                    </p>
                  )}
                  <div className="mt-1 text-xs text-muted-foreground">{new Date(a.occurred_at || a.received_at || a.sent_at || a.created_at).toLocaleString()}</div>
                </div>
                <div className="flex shrink-0 items-start gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  {a.source === "activity" && a.status === "scheduled" && (
                    <Button size="icon" variant="ghost" title="Mark done" onClick={(e) => { e.stopPropagation(); complete.mutate(a.id); }}><CheckCircle2 className="h-4 w-4" /></Button>
                  )}
                  {a.source === "activity" && (
                    <Button size="icon" variant="ghost" title="Edit activity" onClick={(e) => { e.stopPropagation(); openEdit(a); }}><Pencil className="h-4 w-4" /></Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    title={a.source === "communication" ? "Delete email" : "Delete activity"}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(a.source === "communication"
                        ? "Delete this email from Communications?"
                        : "Delete this activity?")) {
                        del.mutate(a);
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!viewingActivity} onOpenChange={(open) => !open && setViewingActivity(null)}>
        <DialogContent className="flex h-[95vh] w-[95vw] max-w-5xl flex-col overflow-hidden sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{viewingActivity?.subject || "Untitled"}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{viewingActivity?.type}</Badge>
            <span className="inline-flex items-center gap-1">
              {viewingActivity?.direction === "inbound" ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
              {viewingActivity?.direction}
            </span>
            {viewingActivity?.customer_name && <span>· {viewingActivity.customer_name}</span>}
            <span>
              · {viewingActivity && new Date(
                viewingActivity.occurred_at || viewingActivity.received_at || viewingActivity.sent_at || viewingActivity.created_at
              ).toLocaleString()}
            </span>
          </div>
          {viewingActivity && (
            looksLikeHtml(viewingActivity.body) ? (
              // Full formatted email, filling the rest of the dialog like an
              // actual email reading pane — sandboxed so any tracking
              // script/link in a saved template can't run in the CRM's own
              // page.
              <iframe
                title="Full message"
                sandbox=""
                srcDoc={viewingActivity.body}
                className="min-h-0 w-full flex-1 rounded-md border bg-white"
              />
            ) : (
              <p className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-sm">{viewingActivity.body}</p>
            )
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
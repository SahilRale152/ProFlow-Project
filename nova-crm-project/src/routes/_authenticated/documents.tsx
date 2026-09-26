import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageHeader, EmptyState, StatCard } from "@/components/PageBits";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Plus, Trash2, ExternalLink, Eye, Share2, Search, UploadCloud } from "lucide-react";
import { toast } from "sonner";

import { API_BASE } from "@/lib/api-base";
const API = `${API_BASE}/api`;

export const Route = createFileRoute("/_authenticated/documents")({
  head: () => ({
    meta: [
      { title: "Documents — OrbitAvanya CRM" },
      { name: "description", content: "Manage document library, contracts, proposals, and customer files." },
    ],
  }),
  component: Documents,
});

/* ---------------- Shared: URL field with real file upload ---------------- */

function FileUrlField({
  label,
  value,
  onChange,
  onSizeDetected,
}: {
  label: string;
  value: string;
  onChange: (url: string) => void;
  onSizeDetected?: (kb: number) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${API}/upload`, { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Upload failed.");
      onChange(data.url);
      onSizeDetected?.(data.size_kb);
      toast.success(`Uploaded ${data.original_name}`);
    } catch (err: any) {
      toast.error(err.message || "Upload failed.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div>
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input placeholder="https://… or upload a file" value={value} onChange={(e) => onChange(e.target.value)} />
        <input
          type="file"
          ref={inputRef}
          className="hidden"
          onChange={handleFile}
          accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.csv,.txt"
        />
        <Button type="button" variant="outline" disabled={uploading} onClick={() => inputRef.current?.click()}>
          <UploadCloud className="mr-2 h-4 w-4" />
          {uploading ? "Uploading…" : "Upload"}
        </Button>
      </div>
    </div>
  );
}

/* ---------------- Shared: status dropdown ---------------- */

function StatusSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border bg-background px-2 py-1 text-xs"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

/* ---------------- Shared: View / Open / Share / Delete action buttons ---------------- */

function FileActions({
  url,
  isShared,
  onShare,
  onDelete,
}: {
  url?: string | null;
  isShared?: boolean;
  onShare: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {url && (
        <>
          <a href={url} target="_blank" rel="noreferrer" title="View">
            <Button size="icon" variant="outline">
              <Eye className="h-4 w-4" />
            </Button>
          </a>
          <a href={url} target="_blank" rel="noreferrer" title="Open">
            <Button size="icon" variant="outline">
              <ExternalLink className="h-4 w-4" />
            </Button>
          </a>
        </>
      )}
      <Button
        size="icon"
        variant={isShared ? "default" : "outline"}
        title={isShared ? "Copy share link (shared)" : "Copy share link"}
        onClick={onShare}
      >
        <Share2 className="h-4 w-4" />
      </Button>
      <Button size="icon" variant="outline" title="Delete" onClick={onDelete}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

async function copyLink(url?: string | null) {
  if (!url) {
    toast.error("No file link to share yet — add a URL or upload a file first.");
    return false;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast.success("Share link copied to clipboard.");
    return true;
  } catch {
    toast.error("Could not copy link.");
    return false;
  }
}

/* ---------------- Root component with tabs ---------------- */

function Documents() {
  const [customers, setCustomers] = useState<any[]>([]);

  useEffect(() => {
    fetch(`${API}/customers`)
      .then((res) => res.json())
      .then((data) => setCustomers(Array.isArray(data) ? data : []))
      .catch(() => setCustomers([]));
  }, []);

  return (
    <div className="w-full max-w-full overflow-x-hidden">
      <PageHeader title="Documents" description="Document library, contracts, proposals, and customer files." />

      <Tabs defaultValue="documents">
        <TabsList className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <TabsTrigger value="documents">Document Management</TabsTrigger>
          <TabsTrigger value="contracts">Contracts</TabsTrigger>
          <TabsTrigger value="proposals">Proposal Files</TabsTrigger>
          <TabsTrigger value="customerFiles">Customer Files</TabsTrigger>
        </TabsList>

        <TabsContent value="documents">
          <DocumentManagementTab customers={customers} />
        </TabsContent>
        <TabsContent value="contracts">
          <ContractsTab customers={customers} />
        </TabsContent>
        <TabsContent value="proposals">
          <ProposalFilesTab customers={customers} />
        </TabsContent>
        <TabsContent value="customerFiles">
          <CustomerFilesTab customers={customers} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* =========================================================================================
   1. Document Management
   ========================================================================================= */

function DocumentManagementTab({ customers }: { customers: any[] }) {
  const [docs, setDocs] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    file_name: "",
    category: "",
    customer_id: "",
    uploaded_by: "",
    file_url: "",
    size_kb: "",
  });

  const load = () => {
    fetch(`${API}/documents`)
      .then((res) => res.json())
      .then((data) => setDocs(Array.isArray(data) ? data : []))
      .catch(() => toast.error("Could not load documents. Is the server running?"));
  };

  useEffect(load, []);

  const addDocument = async () => {
    if (!form.file_name) {
      toast.error("File name is required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, customer_id: form.customer_id || null, size_kb: form.size_kb || 0 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to add document.");
      toast.success(data.message || "Document added.");
      setOpen(false);
      setForm({ file_name: "", category: "", customer_id: "", uploaded_by: "", file_url: "", size_kb: "" });
      load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const shareDocument = async (doc: any) => {
    const ok = await copyLink(doc.file_url);
    if (!ok || doc.is_shared) return;
    try {
      const res = await fetch(`${API}/documents/${doc.id}/share`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_shared: true }),
      });
      const data = await res.json();
      setDocs((prev) => prev.map((d) => (d.id === doc.id ? { ...d, is_shared: data.is_shared } : d)));
    } catch {
      // link was still copied even if the shared flag failed to persist
    }
  };

  const deleteOne = async (id: number) => {
    if (!window.confirm("Delete this document?")) return;
    try {
      await fetch(`${API}/documents/${id}`, { method: "DELETE" });
      setDocs((prev) => prev.filter((d) => d.id !== id));
    } catch {
      toast.error("Failed to delete document.");
    }
  };

  const deleteSelected = async () => {
    if (selectedIds.length === 0) {
      toast.error("Select at least one document first.");
      return;
    }
    if (!window.confirm(`Delete ${selectedIds.length} selected document(s)?`)) return;
    try {
      await fetch(`${API}/documents/delete-selected`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds }),
      });
      setDocs((prev) => prev.filter((d) => !selectedIds.includes(d.id)));
      setSelectedIds([]);
      toast.success("Deleted.");
    } catch {
      toast.error("Failed to delete selected documents.");
    }
  };

  const filtered = docs.filter((d: any) =>
    (d.file_name + " " + (d.category ?? "") + " " + (d.customer_name ?? "")).toLowerCase().includes(q.toLowerCase())
  );

  const totalDocuments = docs.length;
  const storageUsedMb = (docs.reduce((sum, d) => sum + Number(d.size_kb || 0), 0) / 1024).toFixed(1);
  const recentUploads = docs.filter((d) => {
    const days = (Date.now() - new Date(d.created_at).getTime()) / 86400000;
    return days <= 7;
  }).length;
  const sharedCount = docs.filter((d) => d.is_shared).length;

  const allSelected = filtered.length > 0 && filtered.every((d: any) => selectedIds.includes(d.id));

  return (
    <div>
      <div className="mb-4 flex items-center justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-primary shadow-glow">
              <Plus className="mr-2 h-4 w-4" />
              Upload Document
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add document</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              <div>
                <Label>File name *</Label>
                <Input value={form.file_name} onChange={(e) => setForm({ ...form, file_name: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Category</Label>
                  <Input
                    placeholder="Contract, Proposal…"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Customer</Label>
                  <select
                    value={form.customer_id}
                    onChange={(e) => setForm({ ...form, customer_id: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <option value="">— None —</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.company_name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Uploaded by</Label>
                  <Input value={form.uploaded_by} onChange={(e) => setForm({ ...form, uploaded_by: e.target.value })} />
                </div>
                <div>
                  <Label>Size (KB)</Label>
                  <Input
                    type="number"
                    value={form.size_kb}
                    onChange={(e) => setForm({ ...form, size_kb: e.target.value })}
                    placeholder="Auto-filled if you upload a file"
                  />
                </div>
              </div>
              <FileUrlField
                label="File"
                value={form.file_url}
                onChange={(url) => setForm((f) => ({ ...f, file_url: url }))}
                onSizeDetected={(kb) => setForm((f) => ({ ...f, size_kb: String(kb) }))}
              />
            </div>
            <DialogFooter>
              <Button onClick={addDocument} disabled={!form.file_name || saving} className="bg-gradient-primary shadow-glow">
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4 mb-6 md:grid-cols-4">
        <StatCard label="Total Documents" value={totalDocuments} />
        <StatCard label="Storage Used" value={`${storageUsedMb} MB`} />
        <StatCard label="Recent Uploads" value={recentUploads} hint="Last 7 days" />
        <StatCard label="Shared Documents" value={sharedCount} />
      </div>

      <Card className="glass p-4 w-full max-w-full overflow-hidden">
        <div className="mb-3 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search documents…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
          </div>
          <Button size="sm" variant="destructive" onClick={deleteSelected}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete Selected
          </Button>
        </div>

        {filtered.length === 0 ? (
          <EmptyState title="No documents yet" description="Upload your first document to get started." />
        ) : (
          <div className="w-full max-w-full max-h-[600px] overflow-x-auto overflow-y-auto border rounded-md">
            <table className="text-sm border-collapse" style={{ minWidth: "1100px", width: "100%" }}>
              <thead className="sticky top-0 z-10 bg-card border-b">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 px-3 w-8 sticky left-0 bg-card">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(e) => setSelectedIds(e.target.checked ? filtered.map((d) => d.id) : [])}
                    />
                  </th>
                  <th className="py-2 px-3 min-w-[200px]">File</th>
                  <th className="py-2 px-3 min-w-[130px]">Category</th>
                  <th className="py-2 px-3 min-w-[170px]">Customer</th>
                  <th className="py-2 px-3 min-w-[140px]">Uploaded By</th>
                  <th className="py-2 px-3 min-w-[90px]">Size</th>
                  <th className="py-2 px-3 min-w-[110px]">Date</th>
                  <th className="py-2 px-3 min-w-[190px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((d: any) => (
                  <tr key={d.id} className="hover:bg-muted/40">
                    <td className="py-2 px-3 sticky left-0 bg-card">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(d.id)}
                        onChange={(e) =>
                          setSelectedIds((prev) => (e.target.checked ? [...prev, d.id] : prev.filter((x) => x !== d.id)))
                        }
                      />
                    </td>
                    <td className="py-2 px-3 font-medium">
                      <span className="block max-w-[240px] truncate" title={d.file_name}>
                        {d.file_name}
                      </span>
                    </td>
                    <td className="py-2 px-3">{d.category || "—"}</td>
                    <td className="py-2 px-3">
                      <span className="block max-w-[190px] truncate">{d.customer_name || "—"}</span>
                    </td>
                    <td className="py-2 px-3">{d.uploaded_by || "—"}</td>
                    <td className="py-2 px-3">{d.size_kb ? `${d.size_kb} KB` : "—"}</td>
                    <td className="py-2 px-3 text-muted-foreground">
                      {new Date(d.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-2 px-3">
                      <FileActions
                        url={d.file_url}
                        isShared={d.is_shared}
                        onShare={() => shareDocument(d)}
                        onDelete={() => deleteOne(d.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* =========================================================================================
   2. Contracts
   ========================================================================================= */

const CONTRACT_STATUSES = ["Draft", "Pending", "Signed", "Active", "Expired", "Cancelled"];

function ContractsTab({ customers }: { customers: any[] }) {
  const [contracts, setContracts] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    contract_number: "",
    customer_id: "",
    start_date: "",
    end_date: "",
    status: "Draft",
    value: "",
    sales_owner: "",
    attachment_url: "",
    notes: "",
  });

  const load = () => {
    fetch(`${API}/contracts`)
      .then((res) => res.json())
      .then((data) => setContracts(Array.isArray(data) ? data : []))
      .catch(() => toast.error("Could not load contracts. Is the server running?"));
  };

  useEffect(load, []);

  const addContract = async () => {
    if (!form.contract_number) {
      toast.error("Contract number is required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API}/contracts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, customer_id: form.customer_id || null, value: form.value || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to add contract.");
      toast.success(data.message || "Contract added.");
      setOpen(false);
      setForm({
        contract_number: "",
        customer_id: "",
        start_date: "",
        end_date: "",
        status: "Draft",
        value: "",
        sales_owner: "",
        attachment_url: "",
        notes: "",
      });
      load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (contract: any, status: string) => {
    setContracts((prev) => prev.map((c) => (c.id === contract.id ? { ...c, status } : c)));
    try {
      await fetch(`${API}/contracts/${contract.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...contract, status }),
      });
    } catch {
      toast.error("Failed to update status.");
    }
  };

  const shareContract = async (contract: any) => {
    const ok = await copyLink(contract.attachment_url);
    if (!ok || contract.is_shared) return;
    setContracts((prev) => prev.map((c) => (c.id === contract.id ? { ...c, is_shared: true } : c)));
    try {
      await fetch(`${API}/contracts/${contract.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...contract, is_shared: true }),
      });
    } catch {
      // link already copied
    }
  };

  const deleteOne = async (id: number) => {
    if (!window.confirm("Delete this contract?")) return;
    try {
      await fetch(`${API}/contracts/${id}`, { method: "DELETE" });
      setContracts((prev) => prev.filter((c) => c.id !== id));
    } catch {
      toast.error("Failed to delete contract.");
    }
  };

  const deleteSelected = async () => {
    if (selectedIds.length === 0) {
      toast.error("Select at least one contract first.");
      return;
    }
    if (!window.confirm(`Delete ${selectedIds.length} selected contract(s)?`)) return;
    try {
      await fetch(`${API}/contracts/delete-selected`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds }),
      });
      setContracts((prev) => prev.filter((c) => !selectedIds.includes(c.id)));
      setSelectedIds([]);
      toast.success("Deleted.");
    } catch {
      toast.error("Failed to delete selected contracts.");
    }
  };

  const filtered = contracts.filter((c: any) =>
    (c.contract_number + " " + (c.customer_name ?? "") + " " + (c.sales_owner ?? "")).toLowerCase().includes(q.toLowerCase())
  );

  const total = contracts.length;
  const active = contracts.filter((c) => c.status === "Active").length;
  const expired = contracts.filter((c) => c.status === "Expired").length;
  const pendingSignature = contracts.filter((c) => c.status === "Pending").length;

  const allSelected = filtered.length > 0 && filtered.every((c: any) => selectedIds.includes(c.id));

  return (
    <div>
      <div className="mb-4 flex items-center justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-primary shadow-glow">
              <Plus className="mr-2 h-4 w-4" />
              Add Contract
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>New contract</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              <div>
                <Label>Contract number *</Label>
                <Input value={form.contract_number} onChange={(e) => setForm({ ...form, contract_number: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Customer</Label>
                  <select
                    value={form.customer_id}
                    onChange={(e) => setForm({ ...form, customer_id: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <option value="">— None —</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.company_name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Status</Label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    {CONTRACT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Start date</Label>
                  <Input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
                </div>
                <div>
                  <Label>End date</Label>
                  <Input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Value</Label>
                  <Input type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
                </div>
                <div>
                  <Label>Sales owner</Label>
                  <Input value={form.sales_owner} onChange={(e) => setForm({ ...form, sales_owner: e.target.value })} />
                </div>
              </div>
              <FileUrlField
                label="Attachment"
                value={form.attachment_url}
                onChange={(url) => setForm((f) => ({ ...f, attachment_url: url }))}
              />
              <div>
                <Label>Notes</Label>
                <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={addContract}
                disabled={!form.contract_number || saving}
                className="bg-gradient-primary shadow-glow"
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4 mb-6 md:grid-cols-4">
        <StatCard label="Total Contracts" value={total} />
        <StatCard label="Active" value={active} />
        <StatCard label="Expired" value={expired} />
        <StatCard label="Pending Signature" value={pendingSignature} />
      </div>

      <Card className="glass p-4 w-full max-w-full overflow-hidden">
        <div className="mb-3 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search contracts…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
          </div>
          <Button size="sm" variant="destructive" onClick={deleteSelected}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete Selected
          </Button>
        </div>

        {filtered.length === 0 ? (
          <EmptyState title="No contracts yet" description="Add your first contract to start tracking it." />
        ) : (
          <div className="w-full max-w-full max-h-[600px] overflow-x-auto overflow-y-auto border rounded-md">
            <table className="text-sm border-collapse" style={{ minWidth: "1250px", width: "100%" }}>
              <thead className="sticky top-0 z-10 bg-card border-b">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 px-3 w-8 sticky left-0 bg-card">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(e) => setSelectedIds(e.target.checked ? filtered.map((c) => c.id) : [])}
                    />
                  </th>
                  <th className="py-2 px-3 min-w-[150px]">Contract #</th>
                  <th className="py-2 px-3 min-w-[170px]">Customer</th>
                  <th className="py-2 px-3 min-w-[110px]">Start</th>
                  <th className="py-2 px-3 min-w-[110px]">End</th>
                  <th className="py-2 px-3 min-w-[150px]">Status</th>
                  <th className="py-2 px-3 min-w-[110px]">Value</th>
                  <th className="py-2 px-3 min-w-[140px]">Sales Owner</th>
                  <th className="py-2 px-3 min-w-[190px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((c: any) => (
                  <tr key={c.id} className="hover:bg-muted/40">
                    <td className="py-2 px-3 sticky left-0 bg-card">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(c.id)}
                        onChange={(e) =>
                          setSelectedIds((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id)))
                        }
                      />
                    </td>
                    <td className="py-2 px-3 font-medium">{c.contract_number}</td>
                    <td className="py-2 px-3">
                      <span className="block max-w-[190px] truncate">{c.customer_name || "—"}</span>
                    </td>
                    <td className="py-2 px-3">{c.start_date ? new Date(c.start_date).toLocaleDateString() : "—"}</td>
                    <td className="py-2 px-3">{c.end_date ? new Date(c.end_date).toLocaleDateString() : "—"}</td>
                    <td className="py-2 px-3">
                      <StatusSelect value={c.status} options={CONTRACT_STATUSES} onChange={(v) => updateStatus(c, v)} />
                    </td>
                    <td className="py-2 px-3">{c.value ? `₹${Number(c.value).toLocaleString()}` : "—"}</td>
                    <td className="py-2 px-3">{c.sales_owner || "—"}</td>
                    <td className="py-2 px-3">
                      <FileActions
                        url={c.attachment_url}
                        isShared={c.is_shared}
                        onShare={() => shareContract(c)}
                        onDelete={() => deleteOne(c.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* =========================================================================================
   3. Proposal Files
   ========================================================================================= */

const PROPOSAL_STATUSES = ["Draft", "Sent", "Viewed", "Accepted", "Rejected"];

function ProposalFilesTab({ customers }: { customers: any[] }) {
  const [proposals, setProposals] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    proposal_number: "",
    customer_id: "",
    opportunity: "",
    created_by: "",
    status: "Draft",
    version: "1",
    file_url: "",
  });

  const load = () => {
    fetch(`${API}/proposals`)
      .then((res) => res.json())
      .then((data) => setProposals(Array.isArray(data) ? data : []))
      .catch(() => toast.error("Could not load proposals. Is the server running?"));
  };

  useEffect(load, []);

  const addProposal = async () => {
    if (!form.proposal_number) {
      toast.error("Proposal number is required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API}/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, customer_id: form.customer_id || null, version: form.version || 1 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to add proposal.");
      toast.success(data.message || "Proposal added.");
      setOpen(false);
      setForm({ proposal_number: "", customer_id: "", opportunity: "", created_by: "", status: "Draft", version: "1", file_url: "" });
      load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (proposal: any, status: string) => {
    setProposals((prev) => prev.map((p) => (p.id === proposal.id ? { ...p, status } : p)));
    try {
      await fetch(`${API}/proposals/${proposal.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...proposal, status }),
      });
    } catch {
      toast.error("Failed to update status.");
    }
  };

  const shareProposal = async (proposal: any) => {
    const ok = await copyLink(proposal.file_url);
    if (!ok || proposal.is_shared) return;
    setProposals((prev) => prev.map((p) => (p.id === proposal.id ? { ...p, is_shared: true } : p)));
    try {
      await fetch(`${API}/proposals/${proposal.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...proposal, is_shared: true }),
      });
    } catch {
      // link already copied
    }
  };

  const deleteOne = async (id: number) => {
    if (!window.confirm("Delete this proposal?")) return;
    try {
      await fetch(`${API}/proposals/${id}`, { method: "DELETE" });
      setProposals((prev) => prev.filter((p) => p.id !== id));
    } catch {
      toast.error("Failed to delete proposal.");
    }
  };

  const deleteSelected = async () => {
    if (selectedIds.length === 0) {
      toast.error("Select at least one proposal first.");
      return;
    }
    if (!window.confirm(`Delete ${selectedIds.length} selected proposal(s)?`)) return;
    try {
      await fetch(`${API}/proposals/delete-selected`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds }),
      });
      setProposals((prev) => prev.filter((p) => !selectedIds.includes(p.id)));
      setSelectedIds([]);
      toast.success("Deleted.");
    } catch {
      toast.error("Failed to delete selected proposals.");
    }
  };

  const filtered = proposals.filter((p: any) =>
    (p.proposal_number + " " + (p.customer_name ?? "") + " " + (p.opportunity ?? "")).toLowerCase().includes(q.toLowerCase())
  );

  const total = proposals.length;
  const sent = proposals.filter((p) => p.status === "Sent").length;
  const accepted = proposals.filter((p) => p.status === "Accepted").length;
  const rejected = proposals.filter((p) => p.status === "Rejected").length;

  const allSelected = filtered.length > 0 && filtered.every((p: any) => selectedIds.includes(p.id));

  return (
    <div>
      <div className="mb-4 flex items-center justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-primary shadow-glow">
              <Plus className="mr-2 h-4 w-4" />
              Add Proposal
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>New proposal file</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              <div>
                <Label>Proposal number *</Label>
                <Input value={form.proposal_number} onChange={(e) => setForm({ ...form, proposal_number: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Customer</Label>
                  <select
                    value={form.customer_id}
                    onChange={(e) => setForm({ ...form, customer_id: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <option value="">— None —</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.company_name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Opportunity</Label>
                  <Input value={form.opportunity} onChange={(e) => setForm({ ...form, opportunity: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Created by</Label>
                  <Input value={form.created_by} onChange={(e) => setForm({ ...form, created_by: e.target.value })} />
                </div>
                <div>
                  <Label>Status</Label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    {PROPOSAL_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <Label>Version</Label>
                <Input type="number" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
              </div>
              <FileUrlField
                label="File"
                value={form.file_url}
                onChange={(url) => setForm((f) => ({ ...f, file_url: url }))}
              />
            </div>
            <DialogFooter>
              <Button
                onClick={addProposal}
                disabled={!form.proposal_number || saving}
                className="bg-gradient-primary shadow-glow"
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4 mb-6 md:grid-cols-4">
        <StatCard label="Total Proposals" value={total} />
        <StatCard label="Sent" value={sent} />
        <StatCard label="Accepted" value={accepted} />
        <StatCard label="Rejected" value={rejected} />
      </div>

      <Card className="glass p-4 w-full max-w-full overflow-hidden">
        <div className="mb-3 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search proposals…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
          </div>
          <Button size="sm" variant="destructive" onClick={deleteSelected}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete Selected
          </Button>
        </div>

        {filtered.length === 0 ? (
          <EmptyState title="No proposal files yet" description="Add your first proposal to start tracking it." />
        ) : (
          <div className="w-full max-w-full max-h-[600px] overflow-x-auto overflow-y-auto border rounded-md">
            <table className="text-sm border-collapse" style={{ minWidth: "1150px", width: "100%" }}>
              <thead className="sticky top-0 z-10 bg-card border-b">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 px-3 w-8 sticky left-0 bg-card">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(e) => setSelectedIds(e.target.checked ? filtered.map((p) => p.id) : [])}
                    />
                  </th>
                  <th className="py-2 px-3 min-w-[150px]">Proposal #</th>
                  <th className="py-2 px-3 min-w-[170px]">Customer</th>
                  <th className="py-2 px-3 min-w-[160px]">Opportunity</th>
                  <th className="py-2 px-3 min-w-[140px]">Created By</th>
                  <th className="py-2 px-3 min-w-[130px]">Status</th>
                  <th className="py-2 px-3 min-w-[90px]">Version</th>
                  <th className="py-2 px-3 min-w-[190px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((p: any) => (
                  <tr key={p.id} className="hover:bg-muted/40">
                    <td className="py-2 px-3 sticky left-0 bg-card">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(p.id)}
                        onChange={(e) =>
                          setSelectedIds((prev) => (e.target.checked ? [...prev, p.id] : prev.filter((x) => x !== p.id)))
                        }
                      />
                    </td>
                    <td className="py-2 px-3 font-medium">{p.proposal_number}</td>
                    <td className="py-2 px-3">
                      <span className="block max-w-[190px] truncate">{p.customer_name || "—"}</span>
                    </td>
                    <td className="py-2 px-3">
                      <span className="block max-w-[180px] truncate">{p.opportunity || "—"}</span>
                    </td>
                    <td className="py-2 px-3">{p.created_by || "—"}</td>
                    <td className="py-2 px-3">
                      <StatusSelect value={p.status} options={PROPOSAL_STATUSES} onChange={(v) => updateStatus(p, v)} />
                    </td>
                    <td className="py-2 px-3">v{p.version}</td>
                    <td className="py-2 px-3">
                      <FileActions
                        url={p.file_url}
                        isShared={p.is_shared}
                        onShare={() => shareProposal(p)}
                        onDelete={() => deleteOne(p.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* =========================================================================================
   4. Customer Files
   ========================================================================================= */

const CUSTOMER_FILE_STATUSES = ["Verified", "Pending", "Expired", "Rejected"];
const DOCUMENT_TYPES = ["GST", "PAN", "Aadhar", "Passport", "Company Registration", "Invoice", "Purchase Order", "Receipt", "Other"];

function CustomerFilesTab({ customers }: { customers: any[] }) {
  const [files, setFiles] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    customer_id: "",
    document_type: DOCUMENT_TYPES[0],
    file_url: "",
    uploaded_by: "",
    expiry_date: "",
    status: "Pending",
  });

  const load = () => {
    fetch(`${API}/customer-files`)
      .then((res) => res.json())
      .then((data) => setFiles(Array.isArray(data) ? data : []))
      .catch(() => toast.error("Could not load customer files. Is the server running?"));
  };

  useEffect(load, []);

  const addFile = async () => {
    if (!form.customer_id) {
      toast.error("Select a customer first.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API}/customer-files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to add file.");
      toast.success(data.message || "Customer file added.");
      setOpen(false);
      setForm({ customer_id: "", document_type: DOCUMENT_TYPES[0], file_url: "", uploaded_by: "", expiry_date: "", status: "Pending" });
      load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (file: any, status: string) => {
    setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, status } : f)));
    try {
      await fetch(`${API}/customer-files/${file.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...file, status }),
      });
    } catch {
      toast.error("Failed to update status.");
    }
  };

  const shareFile = async (file: any) => {
    const ok = await copyLink(file.file_url);
    if (!ok || file.is_shared) return;
    setFiles((prev) => prev.map((f) => (f.id === file.id ? { ...f, is_shared: true } : f)));
    try {
      await fetch(`${API}/customer-files/${file.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...file, is_shared: true }),
      });
    } catch {
      // link already copied
    }
  };

  const deleteOne = async (id: number) => {
    if (!window.confirm("Delete this file?")) return;
    try {
      await fetch(`${API}/customer-files/${id}`, { method: "DELETE" });
      setFiles((prev) => prev.filter((f) => f.id !== id));
    } catch {
      toast.error("Failed to delete file.");
    }
  };

  const deleteSelected = async () => {
    if (selectedIds.length === 0) {
      toast.error("Select at least one file first.");
      return;
    }
    if (!window.confirm(`Delete ${selectedIds.length} selected file(s)?`)) return;
    try {
      await fetch(`${API}/customer-files/delete-selected`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds }),
      });
      setFiles((prev) => prev.filter((f) => !selectedIds.includes(f.id)));
      setSelectedIds([]);
      toast.success("Deleted.");
    } catch {
      toast.error("Failed to delete selected files.");
    }
  };

  const filtered = files.filter((f: any) =>
    ((f.customer_name ?? "") + " " + (f.document_type ?? "")).toLowerCase().includes(q.toLowerCase())
  );

  const total = files.length;
  const verified = files.filter((f) => f.status === "Verified").length;
  const pending = files.filter((f) => f.status === "Pending").length;
  const expired = files.filter((f) => f.status === "Expired").length;

  const allSelected = filtered.length > 0 && filtered.every((f: any) => selectedIds.includes(f.id));

  return (
    <div>
      <div className="mb-4 flex items-center justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="bg-gradient-primary shadow-glow">
              <Plus className="mr-2 h-4 w-4" />
              Add Customer File
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New customer file</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              <div>
                <Label>Customer *</Label>
                <select
                  value={form.customer_id}
                  onChange={(e) => setForm({ ...form, customer_id: e.target.value })}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <option value="">— Select customer —</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.company_name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Document type</Label>
                  <select
                    value={form.document_type}
                    onChange={(e) => setForm({ ...form, document_type: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    {DOCUMENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Status</Label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    {CUSTOMER_FILE_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Uploaded by</Label>
                  <Input value={form.uploaded_by} onChange={(e) => setForm({ ...form, uploaded_by: e.target.value })} />
                </div>
                <div>
                  <Label>Expiry date</Label>
                  <Input type="date" value={form.expiry_date} onChange={(e) => setForm({ ...form, expiry_date: e.target.value })} />
                </div>
              </div>
              <FileUrlField
                label="File"
                value={form.file_url}
                onChange={(url) => setForm((f) => ({ ...f, file_url: url }))}
              />
            </div>
            <DialogFooter>
              <Button onClick={addFile} disabled={!form.customer_id || saving} className="bg-gradient-primary shadow-glow">
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4 mb-6 md:grid-cols-4">
        <StatCard label="Total Files" value={total} />
        <StatCard label="Verified" value={verified} />
        <StatCard label="Pending" value={pending} />
        <StatCard label="Expired" value={expired} />
      </div>

      <Card className="glass p-4 w-full max-w-full overflow-hidden">
        <div className="mb-3 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search customer files…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
          </div>
          <Button size="sm" variant="destructive" onClick={deleteSelected}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete Selected
          </Button>
        </div>

        {filtered.length === 0 ? (
          <EmptyState title="No customer files yet" description="Upload GST, PAN, contracts and other customer documents here." />
        ) : (
          <div className="w-full max-w-full max-h-[600px] overflow-x-auto overflow-y-auto border rounded-md">
            <table className="text-sm border-collapse" style={{ minWidth: "1100px", width: "100%" }}>
              <thead className="sticky top-0 z-10 bg-card border-b">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 px-3 w-8 sticky left-0 bg-card">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(e) => setSelectedIds(e.target.checked ? filtered.map((f) => f.id) : [])}
                    />
                  </th>
                  <th className="py-2 px-3 min-w-[190px]">Customer</th>
                  <th className="py-2 px-3 min-w-[170px]">Document Type</th>
                  <th className="py-2 px-3 min-w-[140px]">Uploaded By</th>
                  <th className="py-2 px-3 min-w-[120px]">Expiry Date</th>
                  <th className="py-2 px-3 min-w-[130px]">Status</th>
                  <th className="py-2 px-3 min-w-[190px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((f: any) => (
                  <tr key={f.id} className="hover:bg-muted/40">
                    <td className="py-2 px-3 sticky left-0 bg-card">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(f.id)}
                        onChange={(e) =>
                          setSelectedIds((prev) => (e.target.checked ? [...prev, f.id] : prev.filter((x) => x !== f.id)))
                        }
                      />
                    </td>
                    <td className="py-2 px-3 font-medium">
                      <span className="block max-w-[210px] truncate">{f.customer_name || "—"}</span>
                    </td>
                    <td className="py-2 px-3">{f.document_type}</td>
                    <td className="py-2 px-3">{f.uploaded_by || "—"}</td>
                    <td className="py-2 px-3">{f.expiry_date ? new Date(f.expiry_date).toLocaleDateString() : "—"}</td>
                    <td className="py-2 px-3">
                      <StatusSelect value={f.status} options={CUSTOMER_FILE_STATUSES} onChange={(v) => updateStatus(f, v)} />
                    </td>
                    <td className="py-2 px-3">
                      <FileActions
                        url={f.file_url}
                        isShared={f.is_shared}
                        onShare={() => shareFile(f)}
                        onDelete={() => deleteOne(f.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
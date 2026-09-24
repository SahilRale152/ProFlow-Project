import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PageHeader, EmptyState } from "@/components/PageBits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Plus, Search, Trash2, Eye, Upload, ArrowLeft, Building2, Mail, Phone, Globe, User, Tag, MapPin, Sparkles, Loader2, ExternalLink, Copy, Send } from "lucide-react";
import { Users, UserCheck, XCircle } from "lucide-react";
import { getAuthToken } from "@/lib/auth";

const API = "http://localhost:5000/api/customers";

/* Attaches the signed-in user's token to a fetch() call. The backend requires
   this on every /api/* route except /api/auth/*. */
function authHeaders(extra: Record<string, string> = {}) {
  const token = getAuthToken();
  return { ...extra, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

export const Route = createFileRoute("/_authenticated/customers")({
  head: () => ({
    meta: [
      { title: "Customers — OrbitAvanya CRM" },
      { name: "description", content: "Manage customers and contacts." },
    ],
  }),
  component: Customers,
});

function Customers() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<any[]>([]);
  const [originalCustomers, setOriginalCustomers] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [verificationFilter, setVerificationFilter] = useState("All");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);

  /* When set, the whole page swaps to the full customer-details view
     instead of a popup — see CustomerDetailPage below. */
  const [viewingCustomerId, setViewingCustomerId] = useState<number | null>(null);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    company_name: "",
    contact_name: "",
    ceo_name: "",
    email: "",
    phone: "",
    industry: "",
    segment: "",
    website: "",
    notes: "",
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadCustomers = () => {
    fetch(API, { headers: authHeaders() })
      .then((res) => res.json())
      .then((data) => {
        setCustomers(data);
        setOriginalCustomers(JSON.parse(JSON.stringify(data)));
      })
      .catch((err) => {
        console.error(err);
        toast.error("Could not reach the backend. Is the server running?");
      });
  };

  useEffect(() => {
    loadCustomers();
  }, []);

  /* ---------------- Add customer ---------------- */

  const addCustomer = async () => {
    if (!form.company_name) {
      toast.error("Company name is required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to add customer.");
      toast.success(data.message || "Customer added");
      setOpen(false);
      setForm({
        company_name: "",
        contact_name: "",
        ceo_name: "",
        email: "",
        phone: "",
        industry: "",
        segment: "",
        website: "",
        notes: "",
      });
      loadCustomers();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  /* ---------------- Selection ---------------- */

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? filtered.map((c: any) => c.id) : []);
  };

  const toggleSelectOne = (id: number, checked: boolean) => {
    setSelectedIds((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
  };

  /* ---------------- Select duplicates ---------------- */

  /* Groups the currently-filtered rows by a normalized key (company name +
     email + website, whichever are present) and checks every row in each
     group after the first — so the oldest/original record is kept
     unchecked and everything else is pre-selected for the existing
     "Delete Selected" button. */
  const selectDuplicates = () => {
    const normalize = (c: any) =>
      [c.company_name, c.email, c.website]
        .map((v) => String(v || "").trim().toLowerCase())
        .filter(Boolean)
        .join("|");

    const groups = new Map<string, any[]>();
    for (const c of filtered) {
      const key = normalize(c);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }

    const duplicateIds: number[] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => a.id - b.id);
      // Keep the first (oldest) record, select the rest.
      for (const dup of sorted.slice(1)) duplicateIds.push(dup.id);
    }

    if (duplicateIds.length === 0) {
      toast.info("No duplicate customers found.");
      setSelectedIds([]);
      return;
    }

    setSelectedIds(duplicateIds);
    toast.success(
      `Selected ${duplicateIds.length} duplicate customer(s). Review and click "Delete Selected" to remove them.`
    );
  };

  /* ---------------- Bulk delete ---------------- */

  const deleteSelected = async () => {
    if (selectedIds.length === 0) {
      toast.error("Select at least one customer first.");
      return;
    }
    const confirmDelete = window.confirm(`Delete ${selectedIds.length} selected customer(s)?`);
    if (!confirmDelete) return;

    try {
      const res = await fetch(`${API}/delete-selected`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ ids: selectedIds }),
      });
      const data = await res.json();
      toast.success(data.message || "Deleted");
      setCustomers((prev) => prev.filter((c) => !selectedIds.includes(c.id)));
      setSelectedIds([]);
    } catch (err) {
      console.error(err);
      toast.error("Failed to delete selected customers.");
    }
  };

  /* ---------------- Send / remove from Proposals ---------------- */

  /* Marks/unmarks the checked customers as "selected for proposal" — only
     customers marked this way appear in the Proposals generator's CRM
     Customer dropdown. Reuses the same checkbox selection as Delete. */
  const setProposalSelection = async (selected: boolean) => {
    if (selectedIds.length === 0) {
      toast.error("Select at least one customer first.");
      return;
    }
    try {
      const res = await fetch(`${API}/select-for-proposal`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ ids: selectedIds, selected }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to update selection.");
      toast.success(data.message || "Updated.");
      setCustomers((prev) =>
        prev.map((c) => (selectedIds.includes(c.id) ? { ...c, selected_for_proposal: selected } : c))
      );
      setSelectedIds([]);
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Failed to update selection.");
    }
  };

  /* ---------------- Bulk inline edit ---------------- */

  const updateField = (id: number, field: string, value: string) => {
    setCustomers((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  };

  const saveEdits = async () => {
    setSaving(true);
    try {
      for (const c of customers) {
        await fetch(`${API}/${c.id}`, {
          method: "PUT",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            company_name: c.company_name,
            contact_name: c.contact_name,
            email: c.email,
            phone: c.phone,
            industry: c.industry,
            segment: c.segment,
          }),
        });
      }
      toast.success("Changes saved.");
      setOriginalCustomers(JSON.parse(JSON.stringify(customers)));
      setEditMode(false);
    } catch (err) {
      console.error(err);
      toast.error("Failed to save some changes.");
    } finally {
      setSaving(false);
    }
  };

  const cancelEdits = () => {
    setCustomers(JSON.parse(JSON.stringify(originalCustomers)));
    setEditMode(false);
  };

  /* ---------------- Verification ---------------- */

  const toggleVerification = async (customer: any) => {
    const next = customer.verification_status === "Verified" ? "Not Verified" : "Verified";
    try {
      const res = await fetch(`${API}/${customer.id}/verification`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ verification_status: next }),
      });
      const data = await res.json();
      setCustomers((prev) =>
        prev.map((c) => (c.id === customer.id ? { ...c, verification_status: data.verification_status } : c))
      );
    } catch (err) {
      console.error(err);
      toast.error("Failed to update verification status.");
    }
  };

  /* ---------------- Import CSV / Excel ---------------- */

  const normalizeRow = (row: Record<string, any>) => {
    const get = (keys: string[]) => {
      const foundKey = Object.keys(row).find((k) => keys.includes(k.trim().toLowerCase()));
      return foundKey ? String(row[foundKey] ?? "").trim() : "";
    };
    return {
      // Core fields — these are the ones shown on the Customers list.
      company_name: get(["company_name", "company", "company name"]),
      contact_name: get(["contact_name", "contact", "contact name"]),
      ceo_name: get(["ceo_name", "ceo name", "ceo"]),
      email: get(["email", "email address", "company email", "lead email id", "email 1"]),
      phone: get(["phone", "phone number", "company ph no", "company phone"]),
      website: get(["website", "company url", "company website", "url"]),
      industry: get(["industry", "major industry"]),
      segment: get(["segment", "category type", "category"]),
      // Everything else from the sheet — stored, but only shown on the
      // customer's detail page ("View"), not on the main list.
      region: get(["region"]),
      city: get(["city"]),
      country: get(["country"]),
      time_zone: get(["time zone", "timezone"]),
      country_size: get(["country size"]),
      company_size: get(["company size"]),
      employee_count: get(["no of employees", "number of employees", "employees"]),
      category: get(["category"]),
      linkedin_url: get(["linkedin url", "linkedin"]),
      email_2: get(["email 2"]),
      email_3: get(["email 3"]),
      email_4: get(["email 4"]),
      scrape_status: get(["scrape status"]),
    };
  };

  const importCustomers = async (rows: Record<string, any>[]) => {
    const parsed = rows.map(normalizeRow).filter((r) => r.company_name);
    if (parsed.length === 0) {
      toast.error("No valid rows found. Make sure there's a company name column.");
      return;
    }

    const BATCH_SIZE = 1000;
    const totalBatches = Math.ceil(parsed.length / BATCH_SIZE);
    let totalImported = 0;

    toast.info(`Importing ${parsed.length} rows in ${totalBatches} batch(es)…`);

    for (let i = 0; i < parsed.length; i += BATCH_SIZE) {
      const batch = parsed.slice(i, i + BATCH_SIZE);
      try {
        const res = await fetch(`${API}/bulk-import`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ customers: batch }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(data?.message || `Batch ${i / BATCH_SIZE + 1} failed (server error ${res.status}).`);
        }
        totalImported += batch.length;
      } catch (err: any) {
        console.error(err);
        toast.error(`Import stopped: ${err.message}`);
        loadCustomers();
        return;
      }
    }

    toast.success(`Import complete — ${totalImported} customer(s) added.`);
    loadCustomers();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isCsv = file.name.toLowerCase().endsWith(".csv");

    if (isCsv) {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => importCustomers(results.data as Record<string, any>[]),
        error: () => toast.error("Could not read that CSV file."),
      });
    } else {
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const data = evt.target?.result;
          const workbook = XLSX.read(data, { type: "binary" });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(sheet) as Record<string, any>[];
          importCustomers(rows);
        } catch (err) {
          console.error(err);
          toast.error("Could not read that Excel file.");
        }
      };
      reader.readAsBinaryString(file);
    }

    e.target.value = "";
  };

  /* ---------------- Derived data ---------------- */

  const filtered = customers.filter((c: any) => {
    const matchesSearch = (c.company_name + " " + (c.contact_name ?? "") + " " + (c.email ?? ""))
      .toLowerCase()
      .includes(q.toLowerCase());
    const matchesVerification =
      verificationFilter === "All" || c.verification_status === verificationFilter;
    return matchesSearch && matchesVerification;
  });

  const totalCustomers = customers.length;
  const verifiedCount = customers.filter((c) => c.verification_status === "Verified").length;
  const notVerifiedCount = customers.filter((c) => c.verification_status !== "Verified").length;

  const allFilteredSelected = filtered.length > 0 && filtered.every((c: any) => selectedIds.includes(c.id));

  /* Eye icon clicked — swap the whole page to the full customer-details view. */
  if (viewingCustomerId !== null) {
    return <CustomerDetailPage customerId={viewingCustomerId} onBack={() => setViewingCustomerId(null)} />;
  }

  return (
    <div className="w-full max-w-full overflow-x-hidden">
      <PageHeader
        title="Customers"
        description="Companies and contacts in your CRM."
        actions={
          <div className="flex items-center gap-2">
            <select
              value={verificationFilter}
              onChange={(e) => setVerificationFilter(e.target.value)}
              className="rounded-md border px-3 py-2 text-sm bg-background"
            >
              <option value="All">All Customers</option>
              <option value="Verified">Verified</option>
              <option value="Not Verified">Not Verified</option>
            </select>

            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              ref={fileInputRef}
              onChange={handleFileChange}
              className="hidden"
            />
            <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
              <Upload className="mr-2 h-4 w-4" />
              Import
            </Button>

            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button className="bg-gradient-primary shadow-glow">
                  <Plus className="mr-2 h-4 w-4" />
                  Add customer
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>New customer</DialogTitle>
                </DialogHeader>
                <div className="grid gap-3">
                  <div>
                    <Label>Company *</Label>
                    <Input
                      value={form.company_name}
                      onChange={(e) => setForm({ ...form, company_name: e.target.value })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Contact</Label>
                      <Input
                        value={form.contact_name}
                        onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>CEO Name</Label>
                      <Input
                        value={form.ceo_name}
                        onChange={(e) => setForm({ ...form, ceo_name: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Email</Label>
                      <Input
                        type="email"
                        value={form.email}
                        onChange={(e) => setForm({ ...form, email: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>Phone</Label>
                      <Input
                        value={form.phone}
                        onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Industry</Label>
                      <Input
                        value={form.industry}
                        onChange={(e) => setForm({ ...form, industry: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>Segment</Label>
                      <Input
                        placeholder="SMB, Enterprise…"
                        value={form.segment}
                        onChange={(e) => setForm({ ...form, segment: e.target.value })}
                      />
                    </div>
                  </div>
                  <div>
                    <Label>Website</Label>
                    <Input
                      value={form.website}
                      onChange={(e) => setForm({ ...form, website: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Notes</Label>
                    <Textarea
                      value={form.notes}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    onClick={addCustomer}
                    disabled={!form.company_name || saving}
                    className="bg-gradient-primary shadow-glow"
                  >
                    Save
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        }
      />

      <div className="grid gap-4 mb-6 md:grid-cols-3">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Total Customers</p>
              <h2 className="text-2xl font-bold">{totalCustomers}</h2>
            </div>
            <Users className="h-8 w-8 text-primary" />
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Verified</p>
              <h2 className="text-2xl font-bold text-green-600">{verifiedCount}</h2>
            </div>
            <UserCheck className="h-8 w-8 text-green-600" />
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Not Verified</p>
              <h2 className="text-2xl font-bold text-yellow-600">{notVerifiedCount}</h2>
            </div>
            <XCircle className="h-8 w-8 text-yellow-600" />
          </div>
        </Card>
      </div>

      <Card className="glass p-4 w-full max-w-full overflow-hidden">
        <div className="mb-3 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search customers…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="max-w-sm"
            />
          </div>

          <div className="flex gap-2">
            {!editMode ? (
              <Button size="sm" onClick={() => setEditMode(true)}>
                Edit
              </Button>
            ) : (
              <>
                <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={saveEdits} disabled={saving}>
                  Save
                </Button>
                <Button size="sm" variant="outline" onClick={cancelEdits}>
                  Cancel
                </Button>
              </>
            )}
            <Button size="sm" variant="outline" onClick={selectDuplicates}>
              <Copy className="mr-2 h-4 w-4" />
              Select Duplicates
            </Button>
            <Button
              size="sm"
              className="bg-blue-600 hover:bg-blue-700"
              onClick={() => setProposalSelection(true)}
            >
              <Send className="mr-2 h-4 w-4" />
              Send to Proposals
            </Button>
            <Button size="sm" variant="outline" onClick={() => setProposalSelection(false)}>
              <XCircle className="mr-2 h-4 w-4" />
              Remove from Proposals
            </Button>
            <Button size="sm" variant="destructive" onClick={deleteSelected}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete Selected
            </Button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState title="No customers yet" description="Add your first customer to start tracking deals." />
        ) : (
          <div className="w-full max-w-full max-h-[600px] overflow-x-auto overflow-y-auto border rounded-md">
            <table className="text-sm border-collapse" style={{ minWidth: "1250px", width: "100%" }}>
              <thead className="sticky top-0 z-10 bg-card border-b">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 px-3 w-8 sticky left-0 bg-card">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={(e) => toggleSelectAll(e.target.checked)}
                    />
                  </th>
                  <th className="py-2 px-3 min-w-[180px]">Company</th>
                  <th className="py-2 px-3 min-w-[150px]">CEO Name</th>
                  <th className="py-2 px-3 min-w-[190px]">Contact</th>
                  <th className="py-2 px-3 min-w-[220px]">Email</th>
                  <th className="py-2 px-3 min-w-[200px]">Website</th>
                  <th className="py-2 px-3 min-w-[150px]">Industry</th>
                  <th className="py-2 px-3 min-w-[130px]">Segment</th>
                  <th className="py-2 px-3 min-w-[140px]">Verification</th>
                  <th className="py-2 px-3 min-w-[110px]">In Proposals</th>
                  <th className="py-2 px-3 min-w-[70px]">View</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((c: any) => (
                  <tr key={c.id} className="hover:bg-muted/40">
                    <td className="py-2 px-3 sticky left-0 bg-card">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(c.id)}
                        onChange={(e) => toggleSelectOne(c.id, e.target.checked)}
                      />
                    </td>
                    <td className="py-2 px-3 font-medium">
                      {editMode ? (
                        <Input
                          value={c.company_name || ""}
                          onChange={(e) => updateField(c.id, "company_name", e.target.value)}
                          className="h-8 min-w-[160px]"
                        />
                      ) : (
                        <span className="block max-w-[220px] truncate" title={c.company_name}>
                          {c.company_name}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      {editMode ? (
                        <Input
                          value={c.ceo_name || ""}
                          onChange={(e) => updateField(c.id, "ceo_name", e.target.value)}
                          className="h-8 min-w-[140px]"
                        />
                      ) : (
                        <span className="block max-w-[180px] truncate" title={c.ceo_name}>
                          {c.ceo_name}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      {editMode ? (
                        <div className="flex flex-col gap-1 min-w-[170px]">
                          <Input
                            value={c.contact_name || ""}
                            onChange={(e) => updateField(c.id, "contact_name", e.target.value)}
                            className="h-8"
                            placeholder="Contact name"
                          />
                          <Input
                            value={c.phone || ""}
                            onChange={(e) => updateField(c.id, "phone", e.target.value)}
                            className="h-8"
                            placeholder="Phone"
                          />
                        </div>
                      ) : (
                        <div className="max-w-[200px]">
                          <span className="block truncate" title={c.contact_name}>
                            {c.contact_name}
                          </span>
                          {c.phone && (
                            <span className="block truncate text-xs text-muted-foreground" title={c.phone}>
                              {c.phone}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-3 text-muted-foreground">
                      {editMode ? (
                        <Input
                          value={c.email || ""}
                          onChange={(e) => updateField(c.id, "email", e.target.value)}
                          className="h-8 min-w-[200px]"
                        />
                      ) : (
                        <span className="block max-w-[260px] truncate" title={c.email}>
                          {c.email}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      {editMode ? (
                        <Input
                          value={c.website || ""}
                          onChange={(e) => updateField(c.id, "website", e.target.value)}
                          className="h-8 min-w-[180px]"
                        />
                      ) : c.website ? (
                        <a
                          href={c.website.startsWith("http") ? c.website : `https://${c.website}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block max-w-[240px] truncate text-primary underline underline-offset-2"
                          title={c.website}
                        >
                          {c.website}
                        </a>
                      ) : null}
                    </td>
                    <td className="py-2 px-3">
                      {editMode ? (
                        <Input
                          value={c.industry || ""}
                          onChange={(e) => updateField(c.id, "industry", e.target.value)}
                          className="h-8 min-w-[140px]"
                        />
                      ) : (
                        <span className="block max-w-[180px] truncate" title={c.industry}>
                          {c.industry}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      {editMode ? (
                        <Input
                          value={c.segment || ""}
                          onChange={(e) => updateField(c.id, "segment", e.target.value)}
                          className="h-8 min-w-[120px]"
                        />
                      ) : (
                        <span className="block max-w-[150px] truncate" title={c.segment}>
                          {c.segment}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      <button
                        onClick={() => toggleVerification(c)}
                        className="flex items-center gap-2 whitespace-nowrap"
                        title="Click to toggle verification"
                      >
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            c.verification_status === "Verified" ? "bg-green-500" : "bg-yellow-500"
                          }`}
                        />
                        <span
                          className={`text-xs font-medium ${
                            c.verification_status === "Verified" ? "text-green-600" : "text-yellow-600"
                          }`}
                        >
                          {c.verification_status === "Verified" ? "Verified" : "Not Verified"}
                        </span>
                      </button>
                    </td>
                    <td className="py-2 px-3">
                      {c.selected_for_proposal ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-700">
                          <Send className="h-3 w-3" /> Selected
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="icon"
                          variant="outline"
                          title="View Customer"
                          onClick={() => setViewingCustomerId(c.id)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="outline"
                          title="Research with AI"
                          onClick={() => navigate({ to: "/ai-llm", search: { source: "customer", id: c.id } as any })}
                        >
                          <Sparkles className="h-4 w-4" />
                        </Button>
                      </div>
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

/* ---------------------------------------------------------------------- */
/* Renders the AI Company Insights markdown (headers, bold, bullet lists, */
/* numbered lists, and the Key Facts table) with a professional look      */
/* instead of raw text. Used only inside the AI Company Insights card.    */
/* ---------------------------------------------------------------------- */
function AiInsightMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h2: ({ children }) => (
          <h4 className="mt-5 first:mt-0 mb-2 text-[13px] font-semibold uppercase tracking-wide text-primary flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            {children}
          </h4>
        ),
        h3: ({ children }) => (
          <h5 className="mt-4 mb-1.5 text-sm font-semibold text-foreground">{children}</h5>
        ),
        p: ({ children }) => (
          <p className="text-sm leading-relaxed text-foreground/90 mb-2">{children}</p>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold text-foreground">{children}</strong>
        ),
        ul: ({ children }) => (
          <ul className="mb-3 space-y-1.5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-3 space-y-2 list-decimal list-inside marker:font-semibold marker:text-primary">
            {children}
          </ol>
        ),
        li: ({ children }) => (
          <li className="text-sm leading-relaxed text-foreground/90 pl-1 flex gap-2 [&>ol]:mt-1 [&>ul]:mt-1">
            <span className="text-primary mt-1.5 h-1 w-1 rounded-full bg-primary/70 shrink-0 [ol_&]:hidden" />
            <span>{children}</span>
          </li>
        ),
        table: ({ children }) => (
          <div className="mb-3 overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm border-collapse">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
        th: ({ children }) => (
          <th className="text-left font-semibold text-xs uppercase tracking-wide text-muted-foreground px-3 py-2 border-b border-border">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="px-3 py-2 align-top border-b border-border/60 text-foreground/90">{children}</td>
        ),
        hr: () => <hr className="my-4 border-border" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function CustomerDetailPage({ customerId, onBack }: { customerId: number; onBack: () => void }) {
  const [customer, setCustomer] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // AI-generated company profile, built from this customer's own imported/entered
  // data (no outside lookup) — see /api/customers/:id/ai-insights below.
  const [aiInsight, setAiInsight] = useState<{ output_advice: string; created_at: string; sources?: { title: string; url: string }[] } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiGenerating, setAiGenerating] = useState(false);

  const loadCustomer = () => {
    setLoading(true);
    fetch(`${API}/${customerId}`, { headers: authHeaders() })
      .then((res) => {
        if (!res.ok) throw new Error("Customer not found.");
        return res.json();
      })
      .then((data) => setCustomer(data))
      .catch((err) => {
        console.error(err);
        toast.error("Could not load this customer.");
      })
      .finally(() => setLoading(false));
  };

  const loadAiInsight = () => {
    setAiLoading(true);
    fetch(`${API}/${customerId}/ai-insights`, { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setAiInsight(data))
      .catch((err) => console.error(err))
      .finally(() => setAiLoading(false));
  };

  useEffect(loadCustomer, [customerId]);
  useEffect(loadAiInsight, [customerId]);

  const generateAiInsight = async () => {
    setAiGenerating(true);
    try {
      const res = await fetch(`${API}/${customerId}/ai-insights`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to generate insights.");
      setAiInsight(data);
      toast.success("AI insights generated");
    } catch (err: any) {
      toast.error(err.message || "Failed to generate insights.");
    } finally {
      setAiGenerating(false);
    }
  };

  if (loading) {
    return <p className="text-sm text-muted-foreground p-6">Loading customer…</p>;
  }

  if (!customer) {
    return (
      <div className="p-6">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Customers
        </Button>
        <div className="mt-6">
          <EmptyState title="Customer not found" description="This customer may have been deleted." />
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-full overflow-x-hidden">
      <PageHeader
        title={customer.company_name}
        description="All details for this customer in one place."
        actions={
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Customers
          </Button>
        }
      />

      <div className="mb-4 flex items-center gap-2">
        <span
          className={`w-2.5 h-2.5 rounded-full ${
            customer.verification_status === "Verified" ? "bg-green-500" : "bg-yellow-500"
          }`}
        />
        <span
          className={`text-sm font-medium ${
            customer.verification_status === "Verified" ? "text-green-600" : "text-yellow-600"
          }`}
        >
          {customer.verification_status === "Verified" ? "Verified" : "Not Verified"}
        </span>
        <span className="text-sm text-muted-foreground">
          · Tier {customer.segment || "—"} · Added {new Date(customer.created_at).toLocaleDateString()}
        </span>
      </div>

      <Card className="glass p-5 mb-6">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase mb-4">Overview</h3>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <DetailField icon={Building2} label="Company" value={customer.company_name} />
          <DetailField icon={User} label="CEO Name" value={customer.ceo_name} />
          <DetailField icon={User} label="Contact" value={customer.contact_name} />
          <DetailField icon={Mail} label="Email" value={customer.email} />
          <DetailField icon={Phone} label="Phone" value={customer.phone} />
          <DetailField
            icon={Globe}
            label="Website"
            value={customer.website}
            href={customer.website ? (customer.website.startsWith("http") ? customer.website : `https://${customer.website}`) : undefined}
          />
          <DetailField icon={Tag} label="Industry" value={customer.industry} />
          <DetailField icon={Tag} label="Segment" value={customer.segment} />
          <DetailField
            icon={MapPin}
            label="Address"
            value={[customer.address, customer.city, customer.state, customer.country].filter(Boolean).join(", ")}
          />
        </div>
        {customer.notes && (
          <div className="mt-4 pt-4 border-t">
            <p className="text-xs text-muted-foreground uppercase mb-1">Notes</p>
            <p className="text-sm whitespace-pre-wrap">{customer.notes}</p>
          </div>
        )}
      </Card>

      {/* Everything imported from the CSV/Excel sheet that isn't shown on the
          main Customers list lives here instead — only visible on this page. */}
      {(customer.region || customer.time_zone || customer.country_size || customer.company_size ||
        customer.employee_count || customer.category || customer.linkedin_url ||
        customer.email_2 || customer.email_3 || customer.email_4 || customer.scrape_status) && (
        <Card className="glass p-5">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase mb-4">Additional Info</h3>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <DetailField icon={MapPin} label="Region" value={customer.region} />
            <DetailField icon={Tag} label="Time Zone" value={customer.time_zone} />
            <DetailField icon={Tag} label="Country Size" value={customer.country_size} />
            <DetailField icon={Tag} label="Company Size" value={customer.company_size} />
            <DetailField icon={Tag} label="No. of Employees" value={customer.employee_count} />
            <DetailField icon={Tag} label="Category" value={customer.category} />
            <DetailField
              icon={Globe}
              label="LinkedIn"
              value={customer.linkedin_url}
              href={customer.linkedin_url || undefined}
            />
            <DetailField icon={Mail} label="Email 2" value={customer.email_2} />
            <DetailField icon={Mail} label="Email 3" value={customer.email_3} />
            <DetailField icon={Mail} label="Email 4" value={customer.email_4} />
            <DetailField icon={Tag} label="Scrape Status" value={customer.scrape_status} />
          </div>
        </Card>
      )}

      {/* AI-generated read on this company — cross-checks the CRM record above
          against live web search results, then renders as structured markdown. */}
      <Card className="glass mt-6 overflow-hidden p-0">
        <div className="flex items-center justify-between bg-gradient-to-r from-primary/10 via-primary/5 to-transparent px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">AI Company Insights</h3>
              <p className="text-xs text-muted-foreground">Cross-checked against live web research</p>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={generateAiInsight} disabled={aiGenerating}>
            {aiGenerating ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Generating…
              </>
            ) : aiInsight ? (
              "Regenerate"
            ) : (
              "Generate"
            )}
          </Button>
        </div>

        <div className="p-5">
          {aiLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : aiInsight ? (
            <>
              <AiInsightMarkdown content={aiInsight.output_advice} />

              {aiInsight.sources && aiInsight.sources.length > 0 && (
                <div className="mt-4 pt-4 border-t border-border">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                    Sources
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {aiInsight.sources.map((s, i) => (
                      <a
                        key={i}
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-foreground/80 hover:bg-muted hover:text-foreground transition-colors"
                      >
                        {s.title || s.url}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground mt-4">
                Generated {new Date(aiInsight.created_at).toLocaleString()} · includes live web research
              </p>
            </>
          ) : (
            <EmptyState
              title="No AI insights yet"
              description="Generate a company read-out using live web research plus this customer's CRM data — overview, key facts, and sales angles."
            />
          )}
        </div>
      </Card>
    </div>
  );
}

function DetailField({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: any;
  label: string;
  value?: string;
  href?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        {value ? (
          href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-primary underline underline-offset-2 break-all"
            >
              {value}
            </a>
          ) : (
            <p className="text-sm font-medium break-words">{value}</p>
          )
        ) : (
          <p className="text-sm text-muted-foreground">—</p>
        )}
      </div>
    </div>
  );
}
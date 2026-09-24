import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api } from "@/lib/auth";
import { PageHeader, EmptyState, StatCard } from "@/components/PageBits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Building2, FileKey2, Mail, Plus, Search, UserRound } from "lucide-react";

export const Route = createFileRoute("/_authenticated/client-contracts")({
  head: () => ({ meta: [{ title: "Client Contracts — OrbitAvanya CRM" }] }),
  component: ClientContracts,
});

type ClientUser = {
  id: string; email: string; full_name: string | null; role: string;
  email_verified: boolean; created_at: string; contract_count: number;
};

const EMPTY_FORM = {
  user_id: "", contract_number: "", client_company_name: "", contract_title: "",
  status: "active", start_date: "", end_date: "", total_duration: "",
  services_covered: "", contract_value: "", currency: "INR",
  contract_document_url: "", notes: "",
};

function ClientContracts() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const { data: users = [], isLoading, isError, error } = useQuery({
    queryKey: ["admin-client-users"],
    queryFn: () => api("/api/admin/client-users") as Promise<ClientUser[]>,
  });

  const createContract = useMutation({
    mutationFn: () => api("/api/admin/client-contracts", {
      method: "POST",
      body: JSON.stringify({
        user_id: form.user_id,
        contract_number: form.contract_number.trim(),
        client_company_name: form.client_company_name.trim() || null,
        contract_title: form.contract_title.trim() || null,
        status: form.status,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        total_duration: form.total_duration.trim() || null,
        services_covered: form.services_covered.trim() || null,
        contract_value: form.contract_value === "" ? 0 : Number(form.contract_value),
        currency: form.currency,
        contract_document_url: form.contract_document_url.trim() || null,
        notes: form.notes.trim() || null,
      }),
    }),
    onSuccess: () => {
      toast.success("Contract assigned to the login user.");
      setOpen(false); setForm(EMPTY_FORM);
      qc.invalidateQueries({ queryKey: ["admin-client-users"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(u =>
      [u.full_name, u.email, u.role].filter(Boolean)
        .some(v => String(v).toLowerCase().includes(q))
    );
  }, [users, search]);

  const totalUsers = users.length;
  const assignedUsers = users.filter(u => Number(u.contract_count) > 0).length;
  const totalContracts = users.reduce((s, u) => s + Number(u.contract_count || 0), 0);

  function openAssign(user?: ClientUser) {
    setForm({ ...EMPTY_FORM, user_id: user?.id || "", client_company_name: user?.full_name || "" });
    setOpen(true);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Client Contract Management"
        description="Assign commercial contracts to CRM login users. Assigned users can then access their Client Onboarding workspace."
        actions={<Button className="bg-gradient-primary shadow-glow" onClick={() => openAssign()}><Plus className="mr-2 h-4 w-4" />Assign contract</Button>}
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Client logins" value={totalUsers} hint="Total registered client login users" />
        <StatCard label="Assigned users" value={assignedUsers} hint="Users with at least one assigned contract" />
        <StatCard label="Total contracts" value={totalContracts} hint="Total contracts assigned to client users" />
      </div>

      <Card className="glass p-4">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 className="font-semibold">Client login users</h2><p className="text-sm text-muted-foreground">Select a login and assign its contract.</p></div>
          <div className="relative w-full sm:w-80">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search name or email..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        {isLoading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">Loading client login users...</div>
        ) : isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-5">
            <div className="font-medium text-destructive">Unable to load client users</div>
            <div className="mt-1 text-sm text-muted-foreground">{(error as Error)?.message || "Please try again."}</div>
          </div>
        ) : filteredUsers.length === 0 ? (
          <EmptyState title="No client login users found" description="Create or verify a user login first, then return here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead><tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-3 font-medium">User</th><th className="px-3 py-3 font-medium">Role</th>
                <th className="px-3 py-3 font-medium">Verification</th><th className="px-3 py-3 font-medium">Contracts</th>
                <th className="px-3 py-3 text-right font-medium">Action</th>
              </tr></thead>
              <tbody>
                {filteredUsers.map(user => {
                  const count = Number(user.contract_count || 0);
                  return <tr key={user.id} className="border-b last:border-0">
                    <td className="px-3 py-4"><div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10"><UserRound className="h-4 w-4 text-primary" /></div>
                      <div><div className="font-medium">{user.full_name || "Unnamed user"}</div><div className="flex items-center gap-1 text-xs text-muted-foreground"><Mail className="h-3 w-3" />{user.email}</div></div>
                    </div></td>
                    <td className="px-3 py-4"><Badge variant="secondary">{user.role}</Badge></td>
                    <td className="px-3 py-4">{user.email_verified ? <Badge>Verified</Badge> : <Badge variant="outline">Not verified</Badge>}</td>
                    <td className="px-3 py-4">{count > 0 ? <Badge>{count} contract{count === 1 ? "" : "s"}</Badge> : <Badge variant="destructive">Not assigned</Badge>}</td>
                    <td className="px-3 py-4 text-right"><Button size="sm" variant={count ? "outline" : "default"} onClick={() => openAssign(user)}><FileKey2 className="mr-2 h-4 w-4" />{count ? "Add contract" : "Assign contract"}</Button></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><FileKey2 className="h-5 w-5" />Assign client contract</DialogTitle></DialogHeader>
          <div className="grid gap-4">
            <div><Label>Login user *</Label><Select value={form.user_id} onValueChange={v => setForm(f => ({...f, user_id:v}))}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Select a client login" /></SelectTrigger>
              <SelectContent>{users.map(u => <SelectItem key={u.id} value={u.id}>{u.full_name || u.email} — {u.email}</SelectItem>)}</SelectContent>
            </Select></div>

            <div className="grid gap-4 md:grid-cols-2">
              <div><Label>Contract number *</Label><Input className="mt-1" placeholder="CNT-2026-001" value={form.contract_number} onChange={e => setForm(f => ({...f, contract_number:e.target.value}))} /></div>
              <div><Label>Contract title</Label><Input className="mt-1" placeholder="Annual Managed Services Agreement" value={form.contract_title} onChange={e => setForm(f => ({...f, contract_title:e.target.value}))} /></div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div><Label>Client / company name</Label><Input className="mt-1" value={form.client_company_name} onChange={e => setForm(f => ({...f, client_company_name:e.target.value}))} /></div>
              <div><Label>Status</Label><Select value={form.status} onValueChange={v => setForm(f => ({...f, status:v}))}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger><SelectContent>
                  <SelectItem value="draft">Draft</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="completed">Completed</SelectItem><SelectItem value="terminated">Terminated</SelectItem>
                </SelectContent></Select></div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div><Label>Agreement start date</Label><Input className="mt-1" type="date" value={form.start_date} onChange={e => setForm(f => ({...f, start_date:e.target.value}))} /></div>
              <div><Label>Agreement end date</Label><Input className="mt-1" type="date" value={form.end_date} onChange={e => setForm(f => ({...f, end_date:e.target.value}))} /></div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div><Label>Total duration</Label><Input className="mt-1" placeholder="12 months" value={form.total_duration} onChange={e => setForm(f => ({...f, total_duration:e.target.value}))} /></div>
              <div><Label>Contract value</Label><Input className="mt-1" type="number" min="0" step="0.01" value={form.contract_value} onChange={e => setForm(f => ({...f, contract_value:e.target.value}))} /></div>
              <div><Label>Currency</Label><Select value={form.currency} onValueChange={v => setForm(f => ({...f, currency:v}))}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="INR">INR</SelectItem><SelectItem value="USD">USD</SelectItem><SelectItem value="EUR">EUR</SelectItem><SelectItem value="GBP">GBP</SelectItem></SelectContent>
              </Select></div>
            </div>

            <div><Label>Services covered</Label><Textarea className="mt-1" placeholder="Describe services covered by the agreement..." value={form.services_covered} onChange={e => setForm(f => ({...f, services_covered:e.target.value}))} /></div>
            <div><Label>Contract document URL</Label><Input className="mt-1" placeholder="https://..." value={form.contract_document_url} onChange={e => setForm(f => ({...f, contract_document_url:e.target.value}))} /></div>
            <div><Label>Internal notes</Label><Textarea className="mt-1" value={form.notes} onChange={e => setForm(f => ({...f, notes:e.target.value}))} /></div>

            <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground"><div className="flex items-center gap-2 font-medium text-foreground"><Building2 className="h-4 w-4" />After saving</div><p className="mt-1">The contract is linked directly to this login. That user can then open Client Onboarding and see the assigned workspace.</p></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button className="bg-gradient-primary shadow-glow" disabled={!form.user_id || !form.contract_number.trim() || createContract.isPending} onClick={() => createContract.mutate()}>
              {createContract.isPending ? "Assigning..." : "Assign contract"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
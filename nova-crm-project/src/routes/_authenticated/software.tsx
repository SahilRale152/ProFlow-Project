import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban, Building2, ChevronRight, Database, ExternalLink, Loader2, Play,
  Plus, RefreshCw, Search, Settings2, Star, Trash2, X, Code2, ScanLine, StopCircle,
} from "lucide-react";
import { toast } from "sonner";

import { api, getAuthToken } from "@/lib/auth";
import { API_BASE } from "@/lib/api-base";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type ModuleKind = "software" | "digitization";
type TabKey = "live" | "subcontracting";

type Profile = {
  profile_key: string;
  company_name: string;
  certifications?: string[];
  core_services?: string[];
  search_queries?: string[];
  relevant_naics?: string[];
  relevant_psc?: string[];
  exclusion_keywords?: string[];
  is_sme?: boolean;
  default_eligibility?: string;
  default_score?: number;
  default_international_note?: string;
  is_default?: boolean;
};

type Row = Record<string, any> & { id: number; raw_data?: Record<string, any> };

const SOURCE_LABELS: Record<string, string> = {
  SAM: "SAM.gov (US)", "SAM.GOV": "SAM.gov (US)",
  TED: "TED (EU)", UK: "UK (Contracts Finder / Find a Tender)",
};

function clean(v: any) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function raw(row: Row) {
  if (!row?.raw_data) return {};
  if (typeof row.raw_data === "object") return row.raw_data;
  try { return JSON.parse(row.raw_data); } catch { return {}; }
}

function pick(row: Row, ...keys: string[]) {
  const r = raw(row);
  for (const k of keys) {
    const candidates = [k, k.toUpperCase()];
    for (const c of candidates) {
      const v = row?.[c] ?? r?.[c];
      if (v !== null && v !== undefined && String(v).trim() !== "") return v;
    }
  }
  return "";
}

function sourceLabel(v: any) {
  const key = String(v || "").trim().toUpperCase();
  return SOURCE_LABELS[key] || String(v || "—");
}

function sourceClass(v: any) {
  const s = String(v || "").toLowerCase();
  if (s.includes("sam")) return "bg-sky-50 text-sky-700 border-sky-200";
  if (s.includes("ted")) return "bg-violet-50 text-violet-700 border-violet-200";
  return "bg-amber-50 text-amber-700 border-amber-200";
}

function verification(row: Row) {
  const explicit = pick(row, "verification_status", "VERIFICATION_STATUS");
  if (explicit) return explicit;
  const signals = [
    pick(row, "official_website", "COMPANY_WEBSITE", "VERIFIED_OFFICIAL_WEBSITE"),
    pick(row, "company_emails", "ALL_COMPANY_EMAILS", "COMPANY_EMAILS"),
    pick(row, "company_linkedin", "COMPANY_LINKEDIN"),
    pick(row, "executive_linkedins", "ALL_EXECUTIVE_LINKEDINS", "EXECUTIVE_LINKEDINS"),
  ].filter(Boolean).length;
  return signals >= 2 ? "Verified" : signals === 1 ? "Partially verified" : "Not verified";
}

function executive(row: Row) {
  return pick(row, "executive_names_and_roles", "ALL_EXECUTIVE_NAMES & ROLES", "EXECUTIVE_NAMES_AND_ROLES") ||
    [1,2,3].map(i => {
      const n = pick(row, `EXECUTIVE_${i}_NAME`);
      const t = pick(row, `EXECUTIVE_${i}_TITLE`, `EXECUTIVE_${i}_ROLE`);
      return n ? `${n}${t ? ` — ${t}` : ""}` : "";
    }).filter(Boolean).join("; ");
}

function companyName(row: Row, tab: TabKey = "subcontracting") {
  const value = pick(row, "company_name", "COMPANY_NAME", "prime_contractor", "PRIME_CONTRACTOR", "awarded_company", "AWARDED_COMPANY", "legal_company_name", "LEGAL_COMPANY_NAME");
  if (value) return value;
  // A live tender often has no awarded supplier yet. Show the contracting
  // authority as the organization instead of leaving the Company column blank.
  return tab === "live" ? pick(row, "agency", "AGENCY", "contracting_authority", "CONTRACTING_AUTHORITY") : "";
}

function ProfileModal({ profiles, basePath, onClose }: { profiles: Profile[]; basePath: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Partial<Profile> | null>(null);
  const save = useMutation({
    mutationFn: (p: Partial<Profile>) => api(`${basePath}/profiles`, { method: "POST", body: JSON.stringify(p) }),
    onSuccess: () => { toast.success("Eligibility profile saved."); qc.invalidateQueries({ queryKey: [basePath, "profiles"] }); setEditing(null); },
    onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: (key: string) => api(`${basePath}/profiles/${encodeURIComponent(key)}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Profile deleted."); qc.invalidateQueries({ queryKey: [basePath, "profiles"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const def = useMutation({
    mutationFn: (key: string) => api(`${basePath}/profiles/${encodeURIComponent(key)}/default`, { method: "PATCH" }),
    onSuccess: () => { toast.success("Default profile updated."); qc.invalidateQueries({ queryKey: [basePath, "profiles"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const empty = (): Partial<Profile> => ({ profile_key: "", company_name: "", certifications: [], core_services: [], search_queries: [], relevant_naics: [], relevant_psc: [], exclusion_keywords: [], is_sme: true, default_eligibility: "HIGH", default_score: 90 });
  const lines = (a?: string[]) => (a || []).join("\n");
  const arr = (s: string) => s.split("\n").map(x => x.trim()).filter(Boolean);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 p-4 md:p-8">
      <div className="mx-auto flex h-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-background shadow-2xl">
        <div className="flex items-start justify-between border-b px-5 py-4">
          <div><h2 className="text-lg font-semibold">Eligibility Profiles</h2><p className="mt-1 text-xs text-muted-foreground">Controls which services, search terms, certifications and exclusions each scan uses.</p></div>
          <Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {editing ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div><label className="text-xs font-medium">Company name</label><Input value={editing.company_name || ""} onChange={e => setEditing({...editing, company_name:e.target.value})} /></div>
                <div><label className="text-xs font-medium">Profile key</label><Input value={editing.profile_key || ""} onChange={e => setEditing({...editing, profile_key:e.target.value})} /></div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div><label className="text-xs font-medium">Core services (one per line)</label><textarea className="mt-1 h-28 w-full rounded-md border bg-background p-2 text-sm" value={lines(editing.core_services)} onChange={e=>setEditing({...editing,core_services:arr(e.target.value)})} /></div>
                <div><label className="text-xs font-medium">Search queries (one per line)</label><textarea className="mt-1 h-28 w-full rounded-md border bg-background p-2 text-sm" value={lines(editing.search_queries)} onChange={e=>setEditing({...editing,search_queries:arr(e.target.value)})} /></div>
                <div><label className="text-xs font-medium">Certifications (one per line)</label><textarea className="mt-1 h-24 w-full rounded-md border bg-background p-2 text-sm" value={lines(editing.certifications)} onChange={e=>setEditing({...editing,certifications:arr(e.target.value)})} /></div>
                <div><label className="text-xs font-medium">Exclusions (one per line)</label><textarea className="mt-1 h-24 w-full rounded-md border bg-background p-2 text-sm" value={lines(editing.exclusion_keywords)} onChange={e=>setEditing({...editing,exclusion_keywords:arr(e.target.value)})} /></div>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div><label className="text-xs font-medium">Relevant NAICS</label><Input value={(editing.relevant_naics || []).join(", ")} onChange={e=>setEditing({...editing,relevant_naics:e.target.value.split(",").map(x=>x.trim()).filter(Boolean)})} /></div>
                <div><label className="text-xs font-medium">Relevant PSC / CPV</label><Input value={(editing.relevant_psc || []).join(", ")} onChange={e=>setEditing({...editing,relevant_psc:e.target.value.split(",").map(x=>x.trim()).filter(Boolean)})} /></div>
                <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" checked={editing.is_sme ?? true} onChange={e=>setEditing({...editing,is_sme:e.target.checked})} /> SME / startup friendly</label>
              </div>
              <div className="flex justify-end gap-2"><Button variant="outline" onClick={()=>setEditing(null)}>Cancel</Button><Button disabled={save.isPending || !editing.company_name} onClick={()=>save.mutate(editing)}>{save.isPending ? "Saving…" : "Save profile"}</Button></div>
            </div>
          ) : (
            <div className="space-y-3">
              <Button size="sm" className="gap-2" onClick={()=>setEditing(empty())}><Plus className="h-4 w-4"/> New company profile</Button>
              {profiles.map(p=><Card key={p.profile_key}><CardContent className="flex items-center justify-between gap-3 p-4"><div><div className="flex items-center gap-2 font-medium"><Building2 className="h-4 w-4"/>{p.company_name}{p.is_default&&<Badge variant="secondary">Default</Badge>}</div><div className="mt-1 text-xs text-muted-foreground">{(p.certifications||[]).length} certifications · {(p.search_queries||[]).length || "default"} search terms</div></div><div className="flex gap-2">{!p.is_default&&<Button size="sm" variant="outline" onClick={()=>def.mutate(p.profile_key)}>Set default</Button>}<Button size="sm" variant="outline" onClick={()=>setEditing(p)}>Edit</Button>{p.profile_key!=="orbitavanya"&&<Button size="sm" variant="ghost" className="text-destructive" onClick={()=>del.mutate(p.profile_key)}><Trash2 className="h-4 w-4"/></Button>}</div></CardContent></Card>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailModal({ row, tab, onClose }: { row: Row; tab: TabKey; onClose: () => void }) {
  const title = tab === "live" ? pick(row, "tender_title", "TENDER_TITLE") : pick(row, "contract_title", "tender_title", "TENDER_TITLE");
  const r = raw(row);
  const fields = useMemo(() => {
    const preferred = tab === "subcontracting" ? [
      ["Company / Buyer", companyName(row, tab)], ["Legal Company Name", pick(row,"legal_company_name","LEGAL_COMPANY_NAME")],
      ["CEO / Executives", executive(row)], ["Contact / Phone", pick(row,"general_phone","GENERAL_PHONE","PROCUREMENT_PHONE")],
      ["Email", pick(row,"company_emails","ALL_COMPANY_EMAILS","COMPANY_EMAILS")], ["Website", pick(row,"official_website","COMPANY_WEBSITE","VERIFIED_OFFICIAL_WEBSITE")],
      ["Company LinkedIn", pick(row,"company_linkedin","COMPANY_LINKEDIN")], ["Industry", pick(row,"industry","INDUSTRY","domain","DOMAIN")],
      ["Company Description", pick(row,"company_description","COMPANY_DESCRIPTION")], ["What They Need", pick(row,"subcontracting_scope_relevance","LIKELY_SUBCONTRACTABLE_WORK","SUBCONTRACTING_SCOPE_RELEVANCE")],
      ["Why Contact", pick(row,"why_contact_this_company","WHY CONTACT THIS COMPANY","VERIFICATION_EVIDENCE")],
      ["Procurement URL", pick(row,"procurement_url","PROCUREMENT_URL","PROCUREMENT / CONTRACTS URL")], ["Supplier URL", pick(row,"supplier_url","SUPPLIER_URL")],
      ["Subcontracting URL", pick(row,"subcontracting_url","SUBCONTRACTING_URL","SUBCONTRACTING / PARTNER URL")],
      ["Tender / Contract", title], ["Agency / Buyer", pick(row,"agency","AGENCY","CONTRACTING_AUTHORITY")], ["Award Value", pick(row,"award_value","AWARD_VALUE","CONTRACT_VALUE / QUOTATION")],
      ["Award Date", pick(row,"award_date","AWARD_DATE")], ["Contract Period", `${pick(row,"contract_start_date","CONTRACT_START","CONTRACT_START_DATE")} → ${pick(row,"contract_end_date","CONTRACT_END","CONTRACT_END_DATE")}`],
      ["Domain / Subdomain", `${pick(row,"domain","DOMAIN")} / ${pick(row,"subdomain","SUBDOMAIN")}`], ["Score", pick(row,"relevance_score","RELEVANCE_SCORE")],
      ["Verification", verification(row)], ["Source", sourceLabel(pick(row,"source","PLATFORM / SOURCE","SOURCE_PLATFORM"))],
    ] : [
      ["Tender Title", title], ["Source", sourceLabel(pick(row,"source","PLATFORM / SOURCE","SOURCE_PLATFORM"))],
      ["Agency", pick(row,"agency","AGENCY","CONTRACTING_AUTHORITY")], ["Subagency", pick(row,"subagency","SUBAGENCY")],
      ["Domain", pick(row,"domain","DOMAIN")], ["Subdomain", pick(row,"subdomain","SUBDOMAIN")],
      ["Posted", pick(row,"posted_date","POSTED_DATE","PUBLISHED_DATE")], ["Deadline", pick(row,"response_deadline","RESPONSE_DEADLINE","DEADLINE")],
      ["Value", pick(row,"estimated_value","ESTIMATED_VALUE","TENDER_VALUE / QUOTATION")], ["Currency", pick(row,"currency","CURRENCY")],
      ["Score", pick(row,"relevance_score","RELEVANCE_SCORE")], ["Eligibility", pick(row,"eligibility","ORBIT_ELIGIBILITY","ORBITAVANYA_ELIGIBILITY")],
      ["Eligibility Score", pick(row,"eligibility_score","ORBIT_SCORE")], ["Description", pick(row,"description","DESCRIPTION")],
      ["Scope / Relevance", pick(row,"scope_summary","SCOPE_SUMMARY","RELEVANCE_REASON")], ["Location", pick(row,"location","LOCATION","TENDER_COUNTRY")],
      ["NAICS", pick(row,"naics_code","NAICS_CODE")], ["PSC / CPV", pick(row,"psc_code","PSC_CODE","CPV_CODES")],
      ["Buyer Contact", pick(row,"contracting_officer_contact","CONTRACTING_OFFICER_CONTACT","BUYER_CONTACT_NAME","BUYER_CONTACT_EMAILS")],
      ["Verification", pick(row,"verification_status","VERIFICATION_STATUS")],
    ];
    return preferred.filter(([,v]) => v !== "" && v !== "—");
  }, [row, tab, title]);
  const link = tab === "live" ? pick(row,"sam_url","SAM_URL","TED_URL") : pick(row,"sam_url","SAM_URL","TED / OFFICIAL TENDER URL");
  return <div className="fixed inset-0 z-50 bg-black/40 p-4 md:p-8"><div className="mx-auto flex h-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-background shadow-2xl"><div className="flex items-start justify-between border-b px-5 py-4"><div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">{tab === "live" ? "Live Tender" : "Subcontracting Prospect"}</div><h2 className="text-lg font-semibold">{clean(title)}</h2></div><Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4"/></Button></div><div className="min-h-0 flex-1 overflow-y-auto p-5"><div className="grid gap-x-8 gap-y-5 md:grid-cols-2">{fields.map(([k,v])=><div key={k} className="min-w-0"><div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{k}</div><div className="mt-1 break-words whitespace-pre-wrap text-xs leading-relaxed">{clean(v)}</div></div>)}</div><details className="mt-6 rounded-lg border p-3"><summary className="cursor-pointer text-xs font-semibold">All source fields</summary><div className="mt-3 grid gap-3 md:grid-cols-2">{Object.entries(r).map(([k,v])=><div key={k}><div className="text-[10px] uppercase text-muted-foreground">{k}</div><div className="text-xs break-words">{clean(v)}</div></div>)}</div></details>{link&&<Button variant="outline" size="sm" className="mt-4 gap-2" asChild><a href={link} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5"/> Open official/source link</a></Button>}</div></div></div>;
}


function MixedDataTable({ rows, tab, checkedIds, setCheckedIds, setDetailId }: {
  rows: Row[]; tab: TabKey; checkedIds: number[]; setCheckedIds: Dispatch<SetStateAction<number[]>>; setDetailId: (id: number) => void;
}) {
  // Rows must have a real, unique numeric id to be selectable. If a row's
  // id is missing (undefined/null), `checkedIds.includes(r.id)` becomes
  // true for EVERY such row the moment any one of them is checked, since
  // they all compare against the same `undefined` — that reads as
  // "select one, all get selected." Selectable rows are the ones with a
  // real id; anything else gets its checkbox disabled instead of silently
  // joining that shared bucket.
  const selectableRows = rows.filter(r => r.id !== null && r.id !== undefined);
  const brokenRowCount = rows.length - selectableRows.length;
  const allChecked = selectableRows.length > 0 && selectableRows.every(r => checkedIds.includes(r.id));
  const cell = (v: any) => clean(v);
  return <div className="overflow-x-auto">
    {brokenRowCount > 0 && (
      <div className="border-b bg-amber-50 px-3 py-2 text-xs text-amber-700">
        {brokenRowCount} row(s) are missing a database id and can't be selected — resync or re-run the scan for this profile to fix them.
      </div>
    )}
    <table className="w-full min-w-[2400px] text-sm">
      <thead className="border-b bg-muted/40 text-left text-[11px] uppercase text-muted-foreground">
        <tr>
          <th className="sticky left-0 z-10 w-10 bg-muted/40 px-3 py-3"><input type="checkbox" checked={allChecked} onChange={e=>setCheckedIds(e.target.checked?selectableRows.map(r=>r.id):[])}/></th>
          <th className="px-3 py-3">Company / Buyer</th>
          <th className="px-3 py-3">CEO / Executives</th>
          <th className="px-3 py-3">Contact</th>
          <th className="px-3 py-3">Email</th>
          <th className="px-3 py-3">Website</th>
          <th className="px-3 py-3">Category</th>
          <th className="px-3 py-3">Industry / Domain</th>
          <th className="px-3 py-3">Tender / Contract</th>
          <th className="px-3 py-3">Agency / Buyer</th>
          <th className="px-3 py-3">What They Need</th>
          <th className="px-3 py-3">Description / Scope</th>
          <th className="px-3 py-3">Posted</th>
          <th className="px-3 py-3">Deadline</th>
          <th className="px-3 py-3">Award / Est. Value</th>
          <th className="px-3 py-3">Source</th>
          <th className="px-3 py-3">Score</th>
          <th className="px-3 py-3">Eligibility</th>
          <th className="px-3 py-3">Verification</th>
          <th className="px-3 py-3">Proposal</th>
          <th className="px-3 py-3">Action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, index)=>{
          const src=pick(r,"source","PLATFORM / SOURCE","SOURCE_PLATFORM");
          const website=pick(r,"official_website","COMPANY_WEBSITE","VERIFIED_OFFICIAL_WEBSITE","company_website");
          const email=pick(r,"company_emails","ALL_COMPANY_EMAILS","COMPANY_EMAILS","buyer_contact_email","BUYER_CONTACT_EMAILS");
          const need=pick(r,"subcontracting_scope_relevance","LIKELY_SUBCONTRACTABLE_WORK","SUBCONTRACTING_SCOPE_RELEVANCE","what_they_need","WHAT THEY NEED","scope_summary","SCOPE_SUMMARY","relevance_reason","RELEVANCE_REASON");
          const title=pick(r,"contract_title","tender_title","TENDER_TITLE","CONTRACT_TITLE");
          const agency=pick(r,"agency","AGENCY","CONTRACTING_AUTHORITY","BUYER");
          const domain=pick(r,"industry","INDUSTRY","domain","DOMAIN");
          const description=pick(r,"description","DESCRIPTION","scope_summary","SCOPE_SUMMARY","relevance_reason","RELEVANCE_REASON","company_description","COMPANY_DESCRIPTION");
          const value=pick(r,"award_value","AWARD_VALUE","estimated_value","ESTIMATED_VALUE","contract_value","CONTRACT_VALUE / QUOTATION","TENDER_VALUE / QUOTATION");
          const deadline=pick(r,"response_deadline","RESPONSE_DEADLINE","deadline","DEADLINE");
          const posted=pick(r,"posted_date","POSTED_DATE","published_date","PUBLISHED_DATE");
          const hasId = r.id !== null && r.id !== undefined;
          return <tr key={hasId ? `${tab}-${r.id}` : `${tab}-noid-${index}`} className="border-b last:border-0 hover:bg-muted/30 align-top">
            <td className="sticky left-0 z-10 bg-background px-3 py-3">
              <input
                type="checkbox"
                checked={hasId && checkedIds.includes(r.id)}
                disabled={!hasId}
                title={hasId ? undefined : "This row has no database id — resync to select it."}
                onChange={e=>{
                  if (!hasId) return;
                  setCheckedIds(prev=>e.target.checked?[...prev,r.id]:prev.filter(x=>x!==r.id));
                }}
              />
            </td>
            <td className="max-w-[230px] px-3 py-3 font-medium"><div className="line-clamp-2">{cell(companyName(r, tab))}</div><div className="mt-1 text-[11px] text-muted-foreground">{cell(pick(r,"legal_company_name","LEGAL_COMPANY_NAME","company_number","COMPANY_NUMBER"))}</div></td>
            <td className="max-w-[240px] px-3 py-3 text-xs"><div className="line-clamp-3">{cell(executive(r))}</div></td>
            <td className="px-3 py-3 text-xs">{cell(pick(r,"general_phone","GENERAL_PHONE","procurement_phone","PROCUREMENT_PHONE","contact_phone","CONTACT_PHONE","buyer_phone","BUYER_PHONE"))}</td>
            <td className="max-w-[230px] px-3 py-3 text-xs"><div className="line-clamp-2">{cell(email)}</div></td>
            <td className="max-w-[210px] px-3 py-3 text-xs">{website?<a className="text-primary underline break-all" href={String(website)} target="_blank" rel="noreferrer">{String(website)}</a>:"—"}</td>
            <td className="px-3 py-3"><Badge variant="outline">{cell(pick(r,"category","TENDER_CATEGORY"))}</Badge></td>
            <td className="max-w-[190px] px-3 py-3 text-xs"><div>{cell(domain)}</div><div className="text-muted-foreground">{cell(pick(r,"subdomain","SUBDOMAIN"))}</div></td>
            <td className="max-w-[300px] px-3 py-3"><div className="line-clamp-3 font-medium">{cell(title)}</div></td>
            <td className="max-w-[210px] px-3 py-3 text-xs"><div className="line-clamp-3">{cell(agency)}</div></td>
            <td className="max-w-[300px] px-3 py-3 text-xs"><div className="line-clamp-4">{cell(need)}</div></td>
            <td className="max-w-[320px] px-3 py-3 text-xs"><div className="line-clamp-4">{cell(description)}</div></td>
            <td className="px-3 py-3 text-xs whitespace-nowrap">{cell(posted)}</td>
            <td className="px-3 py-3 text-xs whitespace-nowrap">{cell(deadline)}</td>
            <td className="max-w-[170px] px-3 py-3 text-xs"><div>{cell(value)}</div><div className="text-muted-foreground">{cell(pick(r,"currency","CURRENCY"))}</div></td>
            <td className="px-3 py-3"><Badge variant="outline" className={sourceClass(src)}>{sourceLabel(src)}</Badge></td>
            <td className="px-3 py-3"><Badge variant="outline">{cell(pick(r,"relevance_score","RELEVANCE_SCORE","score","SCORE"))}</Badge></td>
            <td className="max-w-[160px] px-3 py-3 text-xs">{cell(pick(r,"eligibility","ORBIT_ELIGIBILITY","ORBITAVANYA_ELIGIBILITY"))}</td>
            <td className="px-3 py-3"><Badge variant="outline">{cell(verification(r))}</Badge></td>
            <td className="px-3 py-3">{r.proposal_status==="done"?<Badge className="bg-emerald-600">Done</Badge>:r.selected_for_proposal?<Badge variant="secondary">Selected</Badge>:<Badge variant="outline">Pending</Badge>}</td>
            <td className="px-3 py-3 text-right"><Button variant="ghost" size="sm" className="gap-1" disabled={!hasId} onClick={()=>hasId && setDetailId(r.id)}>View <ChevronRight className="h-3.5 w-3.5"/></Button></td>
          </tr>
        })}
      </tbody>
    </table>
  </div>;
}

function SamDataPage({ kind, title, description }: { kind: ModuleKind; title: string; description: string }) {
  const qc = useQueryClient();
  const basePath = kind === "software" ? "/api/software" : "/api/digitization";
  const [tab, setTab] = useState<TabKey>("live");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [profileKey, setProfileKey] = useState("orbitavanya");
  const [checkedIds, setCheckedIds] = useState<number[]>([]);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [showProfiles, setShowProfiles] = useState(false);
  const [activeRunIds, setActiveRunIds] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const profilesQuery = useQuery({ queryKey:[basePath,"profiles"], queryFn:()=>api(`${basePath}/profiles`).then(d=>d as {profiles:Profile[]}) });
  const profiles = profilesQuery.data?.profiles || [];
  useEffect(()=>{ if (!profiles.length) return; const current=profiles.find(p=>p.profile_key===profileKey); if (!current) setProfileKey((profiles.find(p=>p.is_default)||profiles[0]).profile_key); },[profiles,profileKey]);
  const statsQuery = useQuery({ queryKey:[basePath,"stats",profileKey], queryFn:()=>api(`${basePath}/stats?profile_key=${encodeURIComponent(profileKey)}`) });
  const table = tab === "live" ? "live-tenders" : "subcontracting-tenders";
  const listQuery = useQuery({ queryKey:[basePath,"list",tab,search,category,profileKey], queryFn:()=>api(`${basePath}/${table}?search=${encodeURIComponent(search)}&profile_key=${encodeURIComponent(profileKey)}${category !== "all" ? `&category=${encodeURIComponent(category)}` : ""}&limit=500`).then(d=>d as {tenders:Row[],total:number}) });
  const scanHistory = useQuery({ queryKey:[basePath,"scan-history",profileKey,activeRunIds], queryFn:()=>api(`${basePath}/scan?profile_key=${encodeURIComponent(profileKey)}`).then(d=>d as {runs:any[]}), enabled:activeRunIds.length>0, refetchInterval:3000 });
  useEffect(()=>{
    if (!activeRunIds.length || !scanHistory.data) return;
    const runs = scanHistory.data.runs.filter(r=>activeRunIds.includes(String(r.id)));
    if (runs.length < activeRunIds.length || runs.some(r=>r.status==="running")) return;
    const failed=runs.filter(r=>r.status==="failed").length; const ok=runs.filter(r=>r.status==="success").length;
    failed ? toast.error(`${ok} source(s) completed, ${failed} failed. Check scan history.`) : toast.success(`All ${ok} sources completed. Excel master is synchronized.`);
    setActiveRunIds([]); qc.invalidateQueries({queryKey:[basePath,"list"]}); qc.invalidateQueries({queryKey:[basePath,"stats"]});
  },[scanHistory.data,activeRunIds,basePath,qc]);
  const scanAll = useMutation({ mutationFn:()=>api(`${basePath}/scan-all`,{method:"POST",body:JSON.stringify({profile_key:profileKey})}), onSuccess:(d:any)=>{ const results=d.results||{}; const ids=Object.values(results).map((r:any)=>r?.run_id).filter((x:any)=>x!==undefined&&x!==null&&String(x).trim()!=="").map((x:any)=>String(x)); if(ids.length){setActiveRunIds(ids);toast.success(`Started all ${ids.length} source scans: SAM.gov, TED and UK.`);} Object.entries(results).filter(([,r]:any)=>r?.run_id===undefined||r?.run_id===null).forEach(([s,r]:any)=>toast.error(`${String(s).toUpperCase()}: ${r?.error||"Could not start. Check backend scan configuration."}`)); }, onError:(e:Error)=>toast.error(e.message) });
  const scanAllStop = useMutation({ mutationFn:()=>api(`${basePath}/scan-all/stop`,{method:"POST",body:JSON.stringify({profile_key:profileKey})}), onSuccess:(d:any)=>{ toast.message(d?.message||"Stop requested — partial results will be saved shortly."); }, onError:(e:Error)=>toast.error(e.message) });
  const select = useMutation({ mutationFn:(selected:boolean)=>api(`${basePath}/${table}/select`,{method:"POST",body:JSON.stringify({ids:checkedIds,selected})}), onSuccess:()=>{toast.success("Proposal selection updated.");setCheckedIds([]);qc.invalidateQueries({queryKey:[basePath,"list"]});qc.invalidateQueries({queryKey:[basePath,"stats"]})},onError:(e:Error)=>toast.error(e.message)});
  const rows=listQuery.data?.tenders||[]; const stats:any=statsQuery.data||{};
  const scanning=scanAll.isPending||activeRunIds.length>0;
  function refreshData(){ qc.invalidateQueries({queryKey:[basePath,"list"]}); qc.invalidateQueries({queryKey:[basePath,"stats"]}); }
  async function downloadExcel(){
    setExporting(true); try { const token=getAuthToken(); const res=await fetch(`${API_BASE}${basePath}/export?profile_key=${encodeURIComponent(profileKey)}`,{headers:token?{Authorization:`Bearer ${token}`}:{}}); if(!res.ok){const b=await res.json().catch(()=>({}));throw new Error(b.message||`Export failed (${res.status})`)} const blob=await res.blob(); const u=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=u; a.download="SAM_DATA_MASTER.xlsx"; document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(u); toast.success("Master Excel downloaded successfully."); } catch(e:any){toast.error(e.message||"Export failed")} finally{setExporting(false)}
  }
  const selectedRow=detailId===null?null:rows.find(r=>r.id===detailId)||null;
  const icon=kind==="software"?<Code2 className="h-5 w-5"/>:<ScanLine className="h-5 w-5"/>;
  return <div className="min-h-screen bg-muted/20">
    <div className="border-b bg-background"><div className="mx-auto max-w-[1800px] px-5 py-5">
      <div className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">{icon}</div><div><h1 className="text-2xl font-semibold tracking-tight">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{description}</p></div></div>
      <div className="flex flex-wrap items-center gap-2"><select className="h-9 rounded-md border bg-background px-3 text-sm" value={profileKey} onChange={e=>setProfileKey(e.target.value)}>{profiles.map(p=><option key={p.profile_key} value={p.profile_key}>{p.company_name}{p.is_default?" (default)":""}</option>)}</select><select className="h-9 rounded-md border bg-background px-3 text-sm" value={category} onChange={e=>setCategory(e.target.value)}><option value="all">All categories</option><option value="application">Applications</option><option value="digitization">Digitization</option><option value="other">Other</option></select><Button variant="outline" size="icon" title="Refresh tender data" onClick={refreshData}><RefreshCw className="h-4 w-4"/></Button><Button variant="outline" className="gap-2" onClick={()=>setShowProfiles(true)}><Settings2 className="h-4 w-4"/> Profiles</Button><Button onClick={()=>scanning?scanAllStop.mutate():scanAll.mutate()} disabled={scanAllStop.isPending} variant={scanning?"destructive":"default"} className="gap-2" title={scanning?"Stop the running scan and save whatever has been collected so far":"Run SAM.gov, TED and UK together"}>{scanning?(scanAllStop.isPending?<Loader2 className="h-4 w-4 animate-spin"/>:<StopCircle className="h-4 w-4"/>):<Play className="h-4 w-4"/>}{scanning?(scanAllStop.isPending?"Stopping…":"Running all 3 sources… (click to stop)"):"Run all 3 sources"}</Button><Button variant="outline" className="gap-2" onClick={downloadExcel} disabled={exporting}><Database className="h-4 w-4"/>{exporting?"Syncing…":"Download Master Excel"}</Button></div></div>
      <div className="mt-5 flex gap-1 border-b">{(["live","subcontracting"] as TabKey[]).map(t=><button key={t} onClick={()=>{setTab(t);setCheckedIds([]);setDetailId(null)}} className={`border-b-2 px-4 py-2 text-sm font-medium ${tab===t?"border-primary text-primary":"border-transparent text-muted-foreground hover:text-foreground"}`}>{t==="live"?"Live Tenders":"Subcontracting / Prospect Companies"}<Badge variant="secondary" className="ml-2">{t==="live"?stats.live?.total??0:stats.subcontracting?.total??0}</Badge></button>)}</div>
    </div></div>
    <div className="mx-auto max-w-[1800px] space-y-5 px-5 py-5">
      <div className="grid gap-4 sm:grid-cols-4"><Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{tab==="live"?"Live tenders":"Subcontracting prospects"}</div><div className="mt-1 text-2xl font-semibold">{tab==="live"?stats.live?.total??"—":stats.subcontracting?.total??"—"}</div></CardContent></Card><Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Selected for proposals</div><div className="mt-1 text-2xl font-semibold">{tab==="live"?stats.live?.selected??"—":stats.subcontracting?.selected??"—"}</div></CardContent></Card><Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Proposals done</div><div className="mt-1 text-2xl font-semibold">{tab==="live"?stats.live?.done??"—":stats.subcontracting?.done??"—"}</div></CardContent></Card><Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Categories</div><div className="mt-1 text-sm font-semibold">Applications · Digitization · Other</div><div className="text-xs text-muted-foreground">SAM.gov · TED · UK</div></CardContent></Card></div>
      <Card><CardHeader className="flex flex-row items-center justify-between gap-3 pb-3"><div className="relative w-full max-w-xl"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"/><Input className="pl-9" placeholder="Search company, tender, agency, email, domain or service…" value={search} onChange={e=>setSearch(e.target.value)}/></div>{checkedIds.length>0&&<div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{checkedIds.length} selected</span><Button size="sm" onClick={()=>select.mutate(true)} className="gap-1"><Star className="h-3.5 w-3.5"/> Mark for proposal</Button><Button size="sm" variant="outline" onClick={()=>select.mutate(false)}>Unmark</Button></div>}</CardHeader><CardContent className="p-0">
        {listQuery.isLoading?<div className="flex min-h-[240px] items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin"/> Loading…</div>:rows.length===0?<div className="flex min-h-[240px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground"><Ban className="h-7 w-7"/><div>No records yet for this profile.</div><div>Click <b>Run all 3 sources</b> to collect and synchronize SAM.gov, TED and UK data.</div></div>:<MixedDataTable rows={rows} tab={tab} checkedIds={checkedIds} setCheckedIds={setCheckedIds} setDetailId={setDetailId}/>} 
      </CardContent></Card>
    </div>
    {selectedRow&&<DetailModal row={selectedRow} tab={tab} onClose={()=>setDetailId(null)}/>} {showProfiles&&<ProfileModal profiles={profiles} basePath={basePath} onClose={()=>setShowProfiles(false)}/>} 
  </div>;
}

export function SoftwarePage(){
  return <SamDataPage kind="software" title="Software / Application" description="Application, software development, web/mobile, API, cloud, AI and related IT opportunities — all three sources run together."/>;
}


import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/software")({
  head: () => ({ meta: [
    { title: "Software / Application — OrbitAvanya CRM" },
    { name: "description", content: "Application and software tenders plus subcontracting prospects from SAM.gov, TED and UK sources." },
  ]}),
  component: SoftwarePage,
});
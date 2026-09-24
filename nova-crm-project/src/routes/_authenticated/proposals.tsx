import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  AlertCircle,
  Archive,
  Building2,
  CheckCircle2,
  Circle,
  Database,
  Download,
  Eye,
  FileCode2,
  FileText,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Search,
  Send,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getAuthToken } from '@/lib/auth'
import { setPendingProposalEmail } from '@/lib/pendingProposalEmail'

export const Route = createFileRoute('/_authenticated/proposals')({
  component: RouteComponent,
})

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

type Customer = {
  id: number
  company_name: string
  contact_name?: string
  ceo_name?: string
  email?: string
  phone?: string
  website?: string
  industry?: string
}

type TemplateSummary = {
  id: number
  name: string
  description?: string
  is_active: boolean
  is_default: boolean
  created_at: string
  updated_at: string
}

type TemplateDetail = TemplateSummary & { html_content: string }

type TenderCustomer = {
  id: number
  company_name: string
  legal_company_name?: string
  company_number?: string
  official_website?: string
  linkedin_url?: string
  company_emails?: string
  executive_name?: string
  executive_role?: string
  executive_email?: string
  primary_domain?: string
  tender_domain?: string
  tender_subdomain?: string
  tender_count?: number
  proposal_status: 'pending' | 'done'
  last_proposal_id?: number | null
  proposal_created_at?: string | null
}

// One row from either SAM Data module (Software / Application or
// Scanning-Digitization), from either of its two tables. Both modules
// are served by the same router with a different table prefix, so the
// rows have an identical shape — only the module key differs.
type SamModule = 'software' | 'digitization'

type DigitizationTender = {
  id: number
  module: SamModule
  table: 'live' | 'subcontracting'
  source: string // SAM | TED | UK
  title: string
  agency?: string
  domain?: string
  relevance_score?: number
  proposal_status: 'pending' | 'done'
  selected_for_proposal?: boolean
  company_emails?: string
  executive_name?: string
  executive_role?: string
  official_website?: string
}

type SamModuleLists = Record<SamModule, { live: DigitizationTender[]; subcontracting: DigitizationTender[] }>

/* Both SAM Data pages write `selected_for_proposal` on their own rows
   ("Mark for proposal"). There is no combined endpoint, so this page
   reads each module's normal list endpoint and keeps the marked rows.
   Emails live in a different column depending on the table: live
   tenders carry the buyer's address, subcontracting rows carry the
   company's / executive's. */
function normalizeSamRow(
  row: Record<string, any>,
  module: SamModule,
  table: 'live' | 'subcontracting'
): DigitizationTender {
  const firstExecutive = String(row.executive_names_and_roles || '').split(/[,;|\n]/)[0] || ''
  const [execName, execRole] = firstExecutive.split(/\s+[-–—]\s+/)
  return {
    id: Number(row.id),
    module,
    table,
    source: String(row.source || row.source_platform || '—'),
    title: String(
      (table === 'live' ? row.tender_title : row.contract_title) ||
        row.prime_contractor ||
        row.company_name ||
        'Untitled'
    ),
    agency: row.agency || row.prime_contractor || row.company_name || '',
    domain: row.domain || row.subdomain || '',
    relevance_score: row.relevance_score ?? undefined,
    proposal_status: row.proposal_status === 'done' ? 'done' : 'pending',
    selected_for_proposal: Boolean(row.selected_for_proposal),
    company_emails:
      table === 'live'
        ? row.buyer_contact_email || row.contracting_officer_contact || ''
        : row.executive_emails || row.procurement_emails || row.company_emails || '',
    executive_name:
      table === 'live' ? row.buyer_contact_name || '' : (execName || '').trim(),
    executive_role: table === 'live' ? 'Buyer / Contracting officer' : (execRole || '').trim(),
    official_website: row.official_website || row.sam_url || row.tender_document_url || '',
  }
}

// Pulls the first usable address out of "John Doe <john@x.com>; ops@x.com".
function firstEmail(value?: string) {
  const match = String(value || '').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)
  return match ? match[0] : ''
}

// A raw .html file sitting in public/templates — not saved in the
// database. Selectable in the Generate tab's dropdown alongside the
// database-backed templates above, but has no editor of its own.
type FileTemplate = {
  id: string // always "file:<filename>"
  name: string
  file_name: string
  source: 'file'
}

// One unified shape the Templates tab's card grid renders, so a
// database template and a public/templates/*.html file look and act
// the same way until you actually open the editor.
type AnyTemplateCard =
  | { kind: 'db'; id: number; name: string; description?: string; is_active: boolean; is_default: boolean; updated_at: string; created_at: string }
  | { kind: 'file'; id: string; file_name: string; name: string }

// What the split editor is currently working on. `original_file_name`
// lets a rename PUT to the right path even after the name field changes.
type EditorState = {
  kind: 'db' | 'file'
  isNew: boolean
  id: number | null
  file_name: string | null
  original_file_name: string | null
  name: string
  description: string
  html_content: string
  is_active: boolean
  is_default: boolean
}

/* ---------------- Bulk generation + Storage types ---------------- */

type ProposalSourceKey = 'crm' | 'tender' | 'software' | 'digitization'

// One ticked-able company in the Generate tab's checklist, from any source.
type PickerCompany = {
  // Same key format Communications uses for its company picker, so a
  // stored proposal can be matched to the right company when emailing.
  key: string
  source: ProposalSourceKey
  table: 'live' | 'subcontracting' | null
  sourceId: number
  title: string // primary line in the checklist
  companyName: string // what is saved with the proposal / used in the email
  subtitle: string
  contactName: string
  email: string
  sourceLabel: string
  statusDone: boolean
}

// One row of the "Generate" progress list.
type BatchItem = {
  key: string
  companyName: string
  status: 'queued' | 'generating' | 'done' | 'error'
  storedId?: string
  proposalNumber?: string
  error?: string
}

type GenerateResponse = {
  html: string
  filename: string
  proposal_number: string
  proposal?: { id?: number } | null
}

// A generated proposal PDF kept in Storage. The database record
// (proposal_files) is written by the server as before; this is the PDF
// copy, kept in the browser's IndexedDB because the server does not keep
// PDF files. Communications reads the same store to attach each
// company's own proposal. KEEP IN SYNC with communications.tsx.
type StoredProposal = {
  id: string
  proposal_id: number | null
  proposal_number: string
  filename: string
  company_key: string
  company_name: string
  contact_name: string
  email: string
  source_label: string
  template_name: string
  opportunity: string
  created_at: string
  sent_at: string | null
  size: number
  blob: Blob
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken()
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers || {}),
    },
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `Request failed (${res.status})`)
  }
  return res.json()
}

// Renders merged proposal HTML to PDF bytes through the server's
// Puppeteer endpoint (same renderer for preview, download and storage).
async function renderPdf(html: string, filename: string): Promise<Blob> {
  const res = await fetch('/api/proposals/export-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, filename }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || 'PDF export failed.')
  }
  return res.blob()
}

// customer-12 | tender-7 | software-live-3 | digitization-sub-9 — identical
// to the ids Communications builds for its company picker.
function companyKeyFor(
  source: ProposalSourceKey,
  table: 'live' | 'subcontracting' | null,
  id: number
) {
  if (source === 'crm') return `customer-${id}`
  if (source === 'tender') return `tender-${id}`
  return `${source}-${table === 'live' ? 'live' : 'sub'}-${id}`
}

// The source-specific part of the /api/proposals/generate request body.
function buildSourcePayload(company: PickerCompany) {
  if (company.source === 'crm') return { customer_id: company.sourceId }
  if (company.source === 'tender') return { tender_customer_id: company.sourceId }
  return {
    digitization_tender_id: company.sourceId,
    digitization_table: company.table,
    // Tells the backend which module's table to read.
    // Software rows live in software_tenders_* — without
    // this the id is looked up in the digitization tables.
    module: company.source,
  }
}

/* ---------------- Proposal Storage (IndexedDB) ---------------- */
// Same DB / store / schema as communications.tsx — keep both in sync.

const PROPOSAL_DB_NAME = 'orbitavanya-crm'
const PROPOSAL_DB_VERSION = 1
const PROPOSAL_STORE = 'stored_proposals'

function openProposalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser does not support local proposal storage.'))
      return
    }
    const request = indexedDB.open(PROPOSAL_DB_NAME, PROPOSAL_DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PROPOSAL_STORE)) {
        request.result.createObjectStore(PROPOSAL_STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open proposal storage.'))
  })
}

async function runProposalStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T> {
  const db = await openProposalDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(PROPOSAL_STORE, mode)
      const request = work(tx.objectStore(PROPOSAL_STORE))
      tx.oncomplete = () => resolve((request ? request.result : undefined) as T)
      tx.onerror = () => reject(tx.error || new Error('Proposal storage failed.'))
      tx.onabort = () => reject(tx.error || new Error('Proposal storage was interrupted.'))
    })
  } finally {
    db.close()
  }
}

async function listStoredProposals(): Promise<StoredProposal[]> {
  const rows = await runProposalStore<StoredProposal[]>('readonly', (store) => store.getAll())
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at))
}

function saveStoredProposal(proposal: StoredProposal) {
  return runProposalStore<IDBValidKey>('readwrite', (store) => store.put(proposal))
}

function deleteStoredProposals(ids: string[]) {
  return runProposalStore<undefined>('readwrite', (store) => {
    ids.forEach((id) => store.delete(id))
  })
}

// Sample merge data for the live preview inside the template editor.
// Mirrors the token names the backend's novaCrmBuildProposalTemplateData
// produces (see server.js) so a template author sees realistic-looking
// text without needing to pick a real customer while editing.
const PREVIEW_SAMPLE_DATA: Record<string, string> = {
  CUSTOMER_COMPANY_NAME: 'Acme Municipal Services',
  CEO_NAME: 'Jordan Reyes',
  CUSTOMER_EMAIL: 'jordan.reyes@acmemunicipal.gov',
  CUSTOMER_CONTACT_NAME: 'Jordan Reyes',
  CUSTOMER_PHONE: '+1 (555) 019-2231',
  CUSTOMER_WEBSITE: 'www.acmemunicipal.gov',
  CUSTOMER_INDUSTRY: 'Government / Public Sector',
  PROPOSAL_DATE: new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }),
  PROPOSAL_NUMBER: 'PROP-PREVIEW-0001',
  TENDER_CUSTOMER_STATUS: 'Pending',
  PROPOSAL_SOURCE: 'Preview',
}

// Same {{TOKEN}} substitution the backend uses (novaCrmMergeProposalTemplate),
// duplicated client-side so the split editor can render a live preview
// without a round trip on every keystroke. Unknown tokens are left as-is.
function mergePreviewTemplate(html: string, data: Record<string, string>) {
  return html.replace(/{{\s*([A-Z0-9_]+)\s*}}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(data, key) ? data[key] : match
  )
}

/* ------------------------------------------------------------------ */
/* Root component                                                      */
/* ------------------------------------------------------------------ */

function RouteComponent() {
  const [tab, setTab] = useState<'generate' | 'storage' | 'templates'>('generate')

  return (
    <div className="min-h-screen bg-muted/20">
      {/* Page header */}
      <div className="border-b bg-background">
        <div className="max-w-7xl mx-auto px-6 py-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-sm">
              <FileText className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Proposal Generator</h1>
              <p className="text-sm text-muted-foreground">
                Select one or many companies and a template, generate their proposals, and keep them in Storage.
              </p>
            </div>
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList>
              <TabsTrigger value="generate" className="gap-1.5">
                <Sparkles className="h-3.5 w-3.5" />
                Generate
              </TabsTrigger>
              <TabsTrigger value="storage" className="gap-1.5">
                <Archive className="h-3.5 w-3.5" />
                Storage
              </TabsTrigger>
              <TabsTrigger value="templates" className="gap-1.5">
                <FileText className="h-3.5 w-3.5" />
                Templates
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6">
        {/* Generate stays mounted (just hidden) so a running batch, the
            ticks and the results survive a look at Storage or Templates. */}
        <div className={tab === 'generate' ? '' : 'hidden'}>
          <GenerateTab onOpenStorage={() => setTab('storage')} />
        </div>
        {tab === 'storage' && <StorageTab />}
        {tab === 'templates' && <TemplatesTab />}
      </div>
    </div>
  )
}


/* ------------------------------------------------------------------ */
/* Tab 1: Generate proposals (one or many companies at once)           */
/* ------------------------------------------------------------------ */

function GenerateTab({ onOpenStorage }: { onOpenStorage: () => void }) {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [tenderCustomers, setTenderCustomers] = useState<TenderCustomer[]>([])
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [fileTemplates, setFileTemplates] = useState<FileTemplate[]>([])
  const [sourceType, setSourceType] = useState<ProposalSourceKey>('crm')
  // Both SAM Data modules, each with its two tables.
  const [samTenders, setSamTenders] = useState<SamModuleLists>({
    software: { live: [], subcontracting: [] },
    digitization: { live: [], subcontracting: [] },
  })
  const [digitizationTable, setDigitizationTable] = useState<'live' | 'subcontracting'>('live')

  // Every ticked company, across ALL four source tabs. Keys use the same
  // format the Communications page uses (customer-12, tender-7,
  // software-live-3, digitization-sub-9 …) so a stored proposal can be
  // matched back to the right company when emailing.
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [search, setSearch] = useState('')

  // Numeric = a database template's id. String ("file:xxx.html") = a
  // raw file in public/templates. Both come from the same dropdown.
  const [templateId, setTemplateId] = useState<number | string | null>(null)
  const [opportunity, setOpportunity] = useState('')

  // The proposal currently shown in the right-hand preview.
  const [previewItem, setPreviewItem] = useState<StoredProposal | null>(null)
  const [previewPdfUrl, setPreviewPdfUrl] = useState<string | null>(null)

  // Progress of the current "Generate" run, one row per company.
  const [batch, setBatch] = useState<BatchItem[]>([])
  const [generating, setGenerating] = useState(false)
  // Companies that already have a PDF in Storage (loaded from this browser).
  const [storedKeys, setStoredKeys] = useState<Set<string>>(new Set())
  // PDFs generated in this session, so a finished row can be previewed
  // instantly without reading Storage again.
  const generatedRef = useRef<Map<string, StoredProposal>>(new Map())

  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  // Cover-image upload (Generate tab "Upload image" button). Updates
  // public/image/Picture1.jpg on the server — every future proposal
  // picks it up automatically, no per-proposal state needed here.
  const [uploadingCover, setUploadingCover] = useState(false)
  const [coverUploadedAt, setCoverUploadedAt] = useState<string | null>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)

  // Fullscreen toggle for the live preview panel — expands the preview
  // to fill the whole page (like a fitted window), Esc or the button exits.
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false)

  useEffect(() => {
    if (!isPreviewFullscreen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsPreviewFullscreen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isPreviewFullscreen])

  useEffect(() => {
    // Only customers explicitly marked "selected for proposal" on the
    // Customers page show up here — same control point as tender
    // customers below.
    api<Customer[]>('/api/customers?selected=true').then(setCustomers).catch((e) => setError(e.message))
    // Only companies explicitly marked "selected for proposal" on the
    // Tender Customers page show up here — that's the control point for
    // which tender companies are eligible to get a proposal generated.
    api<{ customers: TenderCustomer[] }>('/api/tender/customers?selected=true')
      .then((data) => setTenderCustomers(data.customers || []))
      .catch((e) => setError(e.message))
    // Only rows marked "Mark for proposal" on the Software / Application
    // and Scanning & Digitization pages (SAM.gov + TED + UK) show up here.
    // Each module exposes its two tables separately; the marked rows are
    // kept client-side so no combined backend endpoint is needed.
    const loadSamModule = async (module: SamModule) => {
      const [live, sub] = await Promise.all([
        api<{ tenders: Record<string, any>[] }>(`/api/${module}/live-tenders?limit=500`).catch(() => ({
          tenders: [],
        })),
        api<{ tenders: Record<string, any>[] }>(`/api/${module}/subcontracting-tenders?limit=500`).catch(
          () => ({ tenders: [] })
        ),
      ])
      return {
        live: (live.tenders || [])
          .map((row) => normalizeSamRow(row, module, 'live'))
          .filter((row) => row.selected_for_proposal),
        subcontracting: (sub.tenders || [])
          .map((row) => normalizeSamRow(row, module, 'subcontracting'))
          .filter((row) => row.selected_for_proposal),
      }
    }

    Promise.all([loadSamModule('software'), loadSamModule('digitization')])
      .then(([software, digitization]) => setSamTenders({ software, digitization }))
      .catch((e) => setError(e.message))
    api<TemplateSummary[]>('/api/proposal-templates')
      .then((rows) => {
        setTemplates(rows)
        const active = rows.find((t) => t.is_default) || rows.find((t) => t.is_active) || rows[0]
        if (active) setTemplateId(active.id)
      })
      .catch((e) => setError(e.message))
    api<FileTemplate[]>('/api/proposal-templates/files')
      .then(setFileTemplates)
      .catch(() => {
        // Not fatal — the dropdown just won't show file-based templates.
      })
    listStoredProposals()
      .then((rows) => setStoredKeys(new Set(rows.map((r) => r.company_key))))
      .catch(() => {
        // Not fatal — the "stored" tick just won't show.
      })
  }, [])

  useEffect(() => {
    return () => {
      if (previewPdfUrl) URL.revokeObjectURL(previewPdfUrl)
    }
  }, [previewPdfUrl])

  const isSam = sourceType === 'software' || sourceType === 'digitization'
  const isFileTemplateId = typeof templateId === 'string' && templateId.startsWith('file:')
  const selectedTemplate = useMemo(
    () => (isFileTemplateId ? null : templates.find((t) => t.id === templateId) || null),
    [templates, templateId, isFileTemplateId]
  )
  const selectedFileTemplate = useMemo(
    () => (isFileTemplateId ? fileTemplates.find((t) => t.id === templateId) || null : null),
    [fileTemplates, templateId, isFileTemplateId]
  )
  const activeTemplates = useMemo(() => templates.filter((t) => t.is_active), [templates])

  // One flat list of every company that can be ticked, from all sources.
  const pickerCompanies = useMemo<PickerCompany[]>(() => {
    const list: PickerCompany[] = []

    customers.forEach((c) => {
      const email = firstEmail(c.email) || c.email || ''
      const contact = c.ceo_name || c.contact_name || ''
      list.push({
        key: companyKeyFor('crm', null, c.id),
        source: 'crm',
        table: null,
        sourceId: c.id,
        title: c.company_name,
        companyName: c.company_name,
        subtitle: [contact, email].filter(Boolean).join(' · '),
        contactName: contact,
        email,
        sourceLabel: 'Customer',
        statusDone: false,
      })
    })

    tenderCustomers.forEach((t) => {
      const email = firstEmail(t.executive_email) || firstEmail(t.company_emails)
      list.push({
        key: companyKeyFor('tender', null, t.id),
        source: 'tender',
        table: null,
        sourceId: t.id,
        title: t.company_name,
        companyName: t.company_name,
        subtitle: [t.executive_name, email].filter(Boolean).join(' · '),
        contactName: t.executive_name || '',
        email,
        sourceLabel: 'Tender',
        statusDone: t.proposal_status === 'done',
      })
    })
    ;(['software', 'digitization'] as const).forEach((module) => {
      ;(['live', 'subcontracting'] as const).forEach((table) => {
        samTenders[module][table].forEach((t) => {
          const email = firstEmail(t.company_emails)
          list.push({
            key: companyKeyFor(module, table, t.id),
            source: module,
            table,
            sourceId: t.id,
            title: `[${t.source}] ${t.title}`,
            companyName: t.agency || t.title,
            subtitle: [t.executive_name, email].filter(Boolean).join(' · '),
            contactName: t.executive_name || '',
            email,
            sourceLabel: `${module === 'software' ? 'Software' : 'Digitization'} (${
              table === 'live' ? 'Live' : 'Subcontracting'
            })`,
            statusDone: t.proposal_status === 'done',
          })
        })
      })
    })

    return list
  }, [customers, tenderCustomers, samTenders])

  // What the checklist currently shows: the active source tab (and, for
  // the two SAM modules, the active Live / Subcontracting table), narrowed
  // by the search box.
  const visibleCompanies = useMemo(() => {
    const q = search.trim().toLowerCase()
    return pickerCompanies.filter((c) => {
      if (c.source !== sourceType) return false
      if (isSam && c.table !== digitizationTable) return false
      if (!q) return true
      return `${c.title} ${c.subtitle}`.toLowerCase().includes(q)
    })
  }, [pickerCompanies, sourceType, isSam, digitizationTable, search])

  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys])
  const selectedCompanies = useMemo(
    () => pickerCompanies.filter((c) => selectedSet.has(c.key)),
    [pickerCompanies, selectedSet]
  )
  const allVisibleSelected =
    visibleCompanies.length > 0 && visibleCompanies.every((c) => selectedSet.has(c.key))

  const countFor = (source: ProposalSourceKey, table?: 'live' | 'subcontracting') =>
    pickerCompanies.filter((c) => c.source === source && (!table || c.table === table)).length
  const selectedIn = (source: ProposalSourceKey) =>
    selectedCompanies.filter((c) => c.source === source).length

  function toggleCompany(key: string) {
    setSelectedKeys((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
    )
  }

  function toggleAllVisible() {
    const visibleKeys = visibleCompanies.map((c) => c.key)
    setSelectedKeys((current) =>
      allVisibleSelected
        ? current.filter((k) => !visibleKeys.includes(k))
        : [...current, ...visibleKeys.filter((k) => !current.includes(k))]
    )
  }

  function showInPreview(item: StoredProposal) {
    setPreviewItem(item)
    setPreviewPdfUrl(URL.createObjectURL(item.blob))
  }

  async function handleGenerate() {
    if (!templateId || selectedCompanies.length === 0 || generating) return
    const queue = selectedCompanies
    const templateName = isFileTemplateId
      ? selectedFileTemplate?.name || 'File template'
      : selectedTemplate?.name || 'Template'

    setGenerating(true)
    setError(null)
    setBatch(queue.map((c) => ({ key: c.key, companyName: c.companyName, status: 'queued' })))

    const patch = (key: string, next: Partial<BatchItem>) =>
      setBatch((items) => items.map((item) => (item.key === key ? { ...item, ...next } : item)))

    const failedKeys = new Set<string>()

    // One company at a time: each proposal is a Puppeteer render on the
    // server, so running them in parallel would only queue up there.
    for (const company of queue) {
      patch(company.key, { status: 'generating' })
      try {
        const result = await api<GenerateResponse>('/api/proposals/generate', {
          method: 'POST',
          body: JSON.stringify({
            ...buildSourcePayload(company),
            ...(isFileTemplateId
              ? { template_file: selectedFileTemplate?.file_name }
              : { template_id: templateId }),
            opportunity: opportunity || undefined,
            save: true,
          }),
        })

        // Same renderer as "Download PDF", so what gets stored (and later
        // emailed) is exactly what the preview shows.
        const blob = await renderPdf(result.html, result.filename)

        const stored: StoredProposal = {
          id:
            result.proposal?.id != null
              ? `p${result.proposal.id}`
              : `n${result.proposal_number}-${Date.now()}`,
          proposal_id: result.proposal?.id ?? null,
          proposal_number: result.proposal_number,
          filename: result.filename,
          company_key: company.key,
          company_name: company.companyName,
          contact_name: company.contactName,
          email: company.email,
          source_label: company.sourceLabel,
          template_name: templateName,
          opportunity: opportunity || templateName,
          created_at: new Date().toISOString(),
          sent_at: null,
          size: blob.size,
          blob,
        }
        await saveStoredProposal(stored)

        generatedRef.current.set(stored.id, stored)
        setStoredKeys((prev) => new Set(prev).add(company.key))
        patch(company.key, {
          status: 'done',
          storedId: stored.id,
          proposalNumber: stored.proposal_number,
        })
        // The preview follows the run, so it doubles as a progress view.
        // It is only a nicety: the proposal is already saved by this point,
        // so a preview hiccup must not turn it into a "failed" row (which
        // would stay ticked and get regenerated as a duplicate).
        try {
          showInPreview(stored)
        } catch {
          // ignore
        }
      } catch (e: any) {
        failedKeys.add(company.key)
        patch(company.key, { status: 'error', error: e?.message || 'Generation failed.' })
      }
    }

    // Finished companies leave the selection (so clicking Generate twice
    // can't create duplicates); failed ones stay ticked, ready to retry.
    setSelectedKeys((current) => current.filter((key) => failedKeys.has(key)))
    setGenerating(false)
  }

  function handleDownload() {
    if (!previewPdfUrl || !previewItem) return
    const a = document.createElement('a')
    a.href = previewPdfUrl
    a.download = previewItem.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  // Single-company hand-off to Communications for whichever proposal is
  // in the preview (unchanged behaviour). Bulk sending happens in
  // Communications itself, where each company's stored proposal attaches
  // automatically.
  function handleSendToEmail() {
    if (!previewItem) return
    const file = new File([previewItem.blob], previewItem.filename, { type: 'application/pdf' })
    setPendingProposalEmail({
      file,
      filename: previewItem.filename,
      proposalNumber: previewItem.proposal_number,
      recipient_email: previewItem.email,
      recipient_name: previewItem.contact_name,
      company_name: previewItem.company_name,
      subject: `Proposal${previewItem.company_name ? ` — ${previewItem.company_name}` : ''}${
        previewItem.opportunity ? ` — ${previewItem.opportunity}` : ''
      }`,
    })
    navigate({ to: '/communications' })
  }

  async function handleCoverImageChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return
    setUploadingCover(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('image', file)
      const res = await fetch('/api/proposals/cover-image', { method: 'POST', body: form })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message || 'Image upload failed.')
      }
      setCoverUploadedAt(new Date().toLocaleTimeString())
    } catch (err: any) {
      setError(err.message)
    } finally {
      setUploadingCover(false)
    }
  }

  const doneCount = batch.filter((item) => item.status === 'done').length
  const failedCount = batch.filter((item) => item.status === 'error').length
  const finishedCount = doneCount + failedCount
  const runFinished = batch.length > 0 && !generating

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6 items-start">
      {/* Left: selection form */}
      <div className="space-y-5">
        <Card className="shadow-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              Proposal details
            </CardTitle>
            <CardDescription>
              Tick one or many companies, choose a template, and generate all their proposals in one go.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Proposal source</Label>
              {/* One tab per page that can send companies here. Ticks are
                  kept when you switch tabs, so one run can cover several
                  sources. */}
              <div className="grid grid-cols-2 gap-1 rounded-lg border bg-muted/30 p-1">
                {(
                  [
                    { key: 'crm', label: 'Customers' },
                    { key: 'tender', label: 'Tender Customers' },
                    { key: 'software', label: 'Software / App' },
                    { key: 'digitization', label: 'Scanning-Digitization' },
                  ] as const
                ).map((source) => {
                  const picked = selectedIn(source.key)
                  return (
                    <button
                      key={source.key}
                      type="button"
                      onClick={() => {
                        setSourceType(source.key)
                        setDigitizationTable('live')
                        setSearch('')
                      }}
                      className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium transition ${
                        sourceType === source.key
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {source.label}
                      <Badge
                        variant={picked > 0 ? 'default' : 'secondary'}
                        className="px-1.5 text-[10px]"
                        title={picked > 0 ? `${picked} ticked of ${countFor(source.key)}` : undefined}
                      >
                        {picked > 0 ? `${picked}/${countFor(source.key)}` : countFor(source.key)}
                      </Badge>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>
                  {sourceType === 'crm'
                    ? 'Customers'
                    : sourceType === 'tender'
                      ? 'Tender customers'
                      : sourceType === 'software'
                        ? 'Software / Application tenders'
                        : 'Digitization tenders'}
                </Label>
                {sourceType === 'tender' && (
                  <Badge variant="secondary" className="gap-1 text-[10px]">
                    <Database className="h-3 w-3" /> Excel
                  </Badge>
                )}
                {isSam && (
                  <Badge variant="secondary" className="gap-1 text-[10px]">
                    <Database className="h-3 w-3" /> SAM/TED/UK
                  </Badge>
                )}
              </div>

              {isSam && (
                <div className="grid grid-cols-2 rounded-lg border bg-muted/30 p-1">
                  {(
                    [
                      { key: 'live', label: 'Live Tenders' },
                      { key: 'subcontracting', label: 'Subcontracting' },
                    ] as const
                  ).map((table) => (
                    <button
                      key={table.key}
                      type="button"
                      onClick={() => setDigitizationTable(table.key)}
                      className={`rounded-md px-2 py-1.5 text-xs font-medium transition ${
                        digitizationTable === table.key
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {table.label} ({countFor(sourceType, table.key)})
                    </button>
                  ))}
                </div>
              )}

              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search companies…"
                  className="h-8 pl-8 text-xs"
                />
              </div>

              <div className="flex items-center justify-between text-[11px]">
                <button
                  type="button"
                  className="font-medium text-primary hover:underline disabled:opacity-50 disabled:no-underline"
                  disabled={visibleCompanies.length === 0}
                  onClick={toggleAllVisible}
                >
                  {allVisibleSelected ? 'Unselect all' : 'Select all'} ({visibleCompanies.length})
                </button>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                  disabled={selectedKeys.length === 0}
                  onClick={() => setSelectedKeys([])}
                >
                  Clear all ticks
                </button>
              </div>

              <div className="max-h-64 divide-y overflow-y-auto rounded-lg border bg-background">
                {visibleCompanies.map((c) => {
                  const checked = selectedSet.has(c.key)
                  return (
                    <label
                      key={c.key}
                      className={`flex cursor-pointer items-start gap-2.5 px-2.5 py-2 hover:bg-muted/50 ${
                        checked ? 'bg-primary/5' : ''
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                        checked={checked}
                        onChange={() => toggleCompany(c.key)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-xs font-medium">
                          <span className="truncate">{c.title}</span>
                          {(c.statusDone || storedKeys.has(c.key)) && (
                            <CheckCircle2
                              className="h-3.5 w-3.5 shrink-0 text-emerald-600"
                              aria-label="Proposal already generated"
                            />
                          )}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {c.subtitle || 'No contact on file'}
                          {!c.email && (
                            <span
                              className="text-amber-600"
                              title="The proposal still generates, but it can't be emailed from Communications."
                            >
                              {c.subtitle ? ' · ' : ''}no email
                            </span>
                          )}
                        </span>
                      </span>
                    </label>
                  )
                })}
                {visibleCompanies.length === 0 && (
                  <p className="p-3 text-[11px] text-muted-foreground">
                    {search.trim()
                      ? 'No companies match your search.'
                      : sourceType === 'crm'
                        ? 'No customers selected yet — check the box next to a customer on the Customers page and click "Send to Proposals".'
                        : sourceType === 'tender'
                          ? 'No companies selected yet — check the box next to a company on the Tender Customers page and click "Send to Proposals".'
                          : `No tenders marked yet — check a row on the ${
                              sourceType === 'software' ? 'Software / Application' : 'Scanning-Digitization'
                            } page and click "Mark for proposal".`}
                  </p>
                )}
              </div>

              <p className="text-[11px] text-muted-foreground">
                {selectedCompanies.length > 0
                  ? `${selectedCompanies.length} ${
                      selectedCompanies.length === 1 ? 'company' : 'companies'
                    } ticked across all sources.`
                  : 'Tick the companies you want proposals for.'}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="template">Template</Label>
              <Select
                value={templateId != null ? String(templateId) : undefined}
                onValueChange={(v) => setTemplateId(v.startsWith('file:') ? v : Number(v))}
              >
                <SelectTrigger id="template">
                  <SelectValue placeholder="Select a template…" />
                </SelectTrigger>
                <SelectContent>
                  {activeTemplates.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      <span className="flex items-center gap-2">
                        {t.name}
                        {t.is_default && <Star className="h-3 w-3 fill-amber-400 text-amber-400" />}
                      </span>
                    </SelectItem>
                  ))}
                  {fileTemplates.length > 0 && (
                    <>
                      <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
                        From public/templates
                      </div>
                      {fileTemplates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          <span className="flex items-center gap-2">
                            {t.name}
                            <Badge variant="secondary" className="text-[10px] px-1 py-0">
                              file
                            </Badge>
                          </span>
                        </SelectItem>
                      ))}
                    </>
                  )}
                </SelectContent>
              </Select>
              {selectedTemplate?.description && (
                <p className="text-xs text-muted-foreground pt-0.5">{selectedTemplate.description}</p>
              )}
              {selectedFileTemplate && (
                <p className="text-xs text-muted-foreground pt-0.5">
                  Raw file: public/templates/{selectedFileTemplate.file_name}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cover-image-upload">Proposal cover image</Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={uploadingCover}
                  onClick={() => coverInputRef.current?.click()}
                >
                  {uploadingCover ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5" />
                  )}
                  {uploadingCover ? 'Uploading…' : 'Upload image'}
                </Button>
                {coverUploadedAt && (
                  <span className="text-[11px] text-muted-foreground">Updated {coverUploadedAt}</span>
                )}
              </div>
              <input
                id="cover-image-upload"
                ref={coverInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={handleCoverImageChange}
              />
              <p className="text-xs text-muted-foreground">
                Replaces the cover photo used on every proposal (public/image). The logo is loaded automatically
                and doesn't need uploading.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="opportunity">Opportunity / deal name</Label>
              <Input
                id="opportunity"
                value={opportunity}
                onChange={(e) => setOpportunity(e.target.value)}
                placeholder="e.g. eNotifications Pilot"
              />
              <p className="text-xs text-muted-foreground">
                Optional — applied to every proposal in this run and shown in your Proposal Files list.
              </p>
            </div>

            <Separator />

            <Button
              className="w-full gap-2"
              disabled={selectedCompanies.length === 0 || !templateId || generating}
              onClick={handleGenerate}
            >
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {generating
                ? `Generating ${Math.min(finishedCount + 1, batch.length)} of ${batch.length}…`
                : selectedCompanies.length > 1
                  ? `Generate ${selectedCompanies.length} proposals`
                  : 'Generate proposal'}
            </Button>

            {/* Progress / results of the latest run */}
            {batch.length > 0 && (
              <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">
                    {generating
                      ? 'Generating proposals…'
                      : failedCount > 0
                        ? `${doneCount} saved, ${failedCount} failed`
                        : `${doneCount} saved to Storage`}
                  </span>
                  <span className="text-muted-foreground">
                    {finishedCount}/{batch.length}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${(finishedCount / batch.length) * 100}%` }}
                  />
                </div>
                <ul className="max-h-48 space-y-1 overflow-y-auto pt-1">
                  {batch.map((item) => (
                    <li key={item.key} className="flex items-start gap-2 text-xs">
                      {item.status === 'generating' ? (
                        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                      ) : item.status === 'done' ? (
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                      ) : item.status === 'error' ? (
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                      ) : (
                        <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{item.companyName}</span>
                        {item.status === 'done' && (
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">
                            {item.proposalNumber}
                          </span>
                        )}
                        {item.status === 'error' && (
                          <span className="block text-[11px] text-destructive">{item.error}</span>
                        )}
                      </span>
                      {item.status === 'done' && item.storedId && (
                        <button
                          type="button"
                          className="shrink-0 text-[11px] font-medium text-primary hover:underline"
                          onClick={() => {
                            const stored = generatedRef.current.get(item.storedId!)
                            if (stored) showInPreview(stored)
                          }}
                        >
                          Preview
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {runFinished && doneCount > 0 && (
                  <div className="space-y-2 border-t pt-2">
                    <p className="text-[11px] text-muted-foreground">
                      Saved to Storage. In Communications, tick these companies and each one's proposal
                      attaches to its own email automatically.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onOpenStorage}>
                        <Archive className="h-3.5 w-3.5" />
                        Open Storage
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => navigate({ to: '/communications' })}
                      >
                        <Send className="h-3.5 w-3.5" />
                        Communications
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {previewItem && (
              <div className="space-y-2">
                <p className="truncate text-[11px] text-muted-foreground">
                  Previewing: <span className="font-medium text-foreground">{previewItem.company_name}</span>
                </p>
                <Button variant="outline" className="w-full gap-2" onClick={handleDownload}>
                  <Download className="h-4 w-4" />
                  Download PDF
                </Button>
                <Button className="w-full gap-2 bg-gradient-primary shadow-glow" onClick={handleSendToEmail}>
                  <Send className="h-4 w-4" />
                  Send
                </Button>
              </div>
            )}

            {previewItem && (
              <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
                <span>Proposal number</span>
                <Badge variant="secondary" className="font-mono">
                  {previewItem.proposal_number}
                </Badge>
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Right: live preview */}
      <Card
        className={
          isPreviewFullscreen
            ? 'fixed inset-0 z-50 flex flex-col rounded-none shadow-none overflow-hidden'
            : 'shadow-sm overflow-hidden'
        }
      >
        <CardHeader className="border-b bg-muted/30 py-3 shrink-0">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Eye className="h-3.5 w-3.5 text-muted-foreground" />
              Live preview
            </CardTitle>
            <div className="flex items-center gap-2">
              {previewItem && (
                <Badge variant="outline" className="text-[11px] font-normal">
                  {previewItem.filename}
                </Badge>
              )}
              {previewPdfUrl && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title={isPreviewFullscreen ? 'Exit full screen' : 'Full screen'}
                  onClick={() => setIsPreviewFullscreen((v) => !v)}
                >
                  {isPreviewFullscreen ? (
                    <Minimize2 className="h-3.5 w-3.5" />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className={isPreviewFullscreen ? 'p-0 bg-[#e9ebef] flex-1 min-h-0' : 'p-0 bg-[#e9ebef]'}>
          {previewPdfUrl ? (
            <div
              className={
                isPreviewFullscreen
                  ? 'w-full h-full bg-[#d9dce2] p-4'
                  : 'w-full h-[82vh] bg-[#d9dce2] p-4'
              }
            >
              <iframe
                title="Proposal PDF preview"
                src={previewPdfUrl}
                className="w-full h-full rounded-md bg-white shadow-sm"
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-[520px] text-center gap-3 px-8">
              <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
                <FileText className="h-6 w-6 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">No preview yet</p>
                <p className="text-xs text-muted-foreground max-w-xs">
                  Tick one or more companies and choose a template, then click "Generate". Every proposal is
                  rendered with the same A4 PDF renderer as Download PDF and saved to Storage; the preview shows
                  the latest one, and you can re-open any finished row from the results list.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tab 2: Storage — every generated proposal PDF, ready to email       */
/* ------------------------------------------------------------------ */

function StorageTab() {
  const [items, setItems] = useState<StoredProposal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [viewing, setViewing] = useState<{ url: string; title: string } | null>(null)

  function refresh() {
    setLoading(true)
    setError(null)
    listStoredProposals()
      .then((rows) => {
        setItems(rows)
        // Drop ticks for rows that no longer exist.
        setSelected((current) => current.filter((id) => rows.some((row) => row.id === id)))
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(refresh, [])

  useEffect(() => {
    return () => {
      if (viewing) URL.revokeObjectURL(viewing.url)
    }
  }, [viewing])

  useEffect(() => {
    if (!viewing) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewing(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [viewing])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter((item) =>
      `${item.company_name} ${item.proposal_number} ${item.email} ${item.contact_name} ${item.source_label}`
        .toLowerCase()
        .includes(q)
    )
  }, [items, search])

  const allFilteredSelected = filtered.length > 0 && filtered.every((item) => selected.includes(item.id))

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((v) => v !== id) : [...current, id]))
  }

  function toggleAll() {
    const ids = filtered.map((item) => item.id)
    setSelected((current) =>
      allFilteredSelected ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])]
    )
  }

  function download(item: StoredProposal) {
    const url = URL.createObjectURL(item.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = item.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function remove(ids: string[]) {
    if (ids.length === 0) return
    const ok = confirm(
      `Remove ${ids.length === 1 ? 'this proposal' : `these ${ids.length} proposals`} from Storage?\n\n` +
        'The record in Proposal Files is kept — only the stored PDF copy is deleted.'
    )
    if (!ok) return
    try {
      await deleteStoredProposals(ids)
      refresh()
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Archive className="h-4 w-4 text-primary" />
                Stored proposals
                <Badge variant="secondary" className="text-[10px]">
                  {items.length}
                </Badge>
              </CardTitle>
              <CardDescription className="mt-1">
                Every proposal generated here is kept as a PDF. In Communications, ticking a company attaches its
                proposal to that company's email automatically.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search company, number, email…"
                  className="h-8 w-64 pl-8 text-xs"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-destructive hover:text-destructive"
                disabled={selected.length === 0}
                onClick={() => remove(selected)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete{selected.length > 0 ? ` (${selected.length})` : ''}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <div className="mx-6 mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading storage…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-8 py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                <Archive className="h-6 w-6 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">{items.length === 0 ? 'Nothing stored yet' : 'No matches'}</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  {items.length === 0
                    ? 'Generate proposals for one or more companies on the Generate tab and they will appear here.'
                    : 'Try a different search.'}
                </p>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-y bg-muted/30 text-[11px] text-muted-foreground">
                  <tr>
                    <th className="w-10 px-4 py-2.5">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-primary"
                        checked={allFilteredSelected}
                        onChange={toggleAll}
                        aria-label="Select all"
                      />
                    </th>
                    <th className="px-3 py-2.5 font-medium">Company</th>
                    <th className="px-3 py-2.5 font-medium">Proposal</th>
                    <th className="px-3 py-2.5 font-medium">Contact</th>
                    <th className="px-3 py-2.5 font-medium">Generated</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((item) => (
                    <tr key={item.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-primary"
                          checked={selected.includes(item.id)}
                          onChange={() => toggle(item.id)}
                          aria-label={`Select ${item.company_name}`}
                        />
                      </td>
                      <td className="max-w-[240px] px-3 py-3">
                        <div className="truncate text-sm font-medium">{item.company_name}</div>
                        <div className="text-[11px] text-muted-foreground">{item.source_label}</div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-mono text-[11px]">{item.proposal_number}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {item.template_name} · {Math.max(1, Math.round(item.size / 1024))} KB
                        </div>
                      </td>
                      <td className="max-w-[220px] px-3 py-3">
                        <div className="truncate">{item.contact_name || '—'}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {item.email || 'No email on this record'}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">
                        {new Date(item.created_at).toLocaleString()}
                      </td>
                      <td className="px-3 py-3">
                        {item.sent_at ? (
                          <Badge className="bg-emerald-600 text-[10px]" title={new Date(item.sent_at).toLocaleString()}>
                            Sent
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            Ready to send
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="Preview"
                            onClick={() => setViewing({ url: URL.createObjectURL(item.blob), title: item.filename })}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="Download PDF"
                            onClick={() => download(item)}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            title="Remove from Storage"
                            onClick={() => remove([item.id])}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="px-1 text-[11px] text-muted-foreground">
        The proposal record is saved to the CRM database as before. The PDF copies listed here are kept in this
        browser, so use the same browser when emailing them from Communications.
      </p>

      {/* PDF viewer */}
      {viewing && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2.5">
            <span className="truncate text-sm font-medium">{viewing.title}</span>
            <Button variant="ghost" size="icon" className="h-7 w-7" title="Close" onClick={() => setViewing(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 bg-[#d9dce2] p-4">
            <iframe title="Stored proposal" src={viewing.url} className="h-full w-full rounded-md bg-white shadow-sm" />
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tab 2: Manage templates                                             */
/* ------------------------------------------------------------------ */

function TemplatesTab() {
  const [dbTemplates, setDbTemplates] = useState<TemplateSummary[]>([])
  const [fileTemplates, setFileTemplates] = useState<FileTemplate[]>([])
  const [editing, setEditing] = useState<EditorState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingEditor, setLoadingEditor] = useState(false)
  const [newPickerOpen, setNewPickerOpen] = useState(false)

  function refresh() {
    setLoadingList(true)
    setError(null)
    Promise.all([
      api<TemplateSummary[]>('/api/proposal-templates'),
      api<FileTemplate[]>('/api/proposal-templates/files').catch(() => []),
    ])
      .then(([db, files]) => {
        setDbTemplates(db)
        setFileTemplates(files)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingList(false))
  }

  useEffect(refresh, [])

  // Unified card list: database templates first (newest/default first,
  // same order the API already returns), then raw files from disk.
  const cards: AnyTemplateCard[] = useMemo(
    () => [
      ...dbTemplates.map((t): AnyTemplateCard => ({ kind: 'db', ...t })),
      ...fileTemplates.map((t): AnyTemplateCard => ({ kind: 'file', id: t.id, file_name: t.file_name, name: t.name })),
    ],
    [dbTemplates, fileTemplates]
  )

  async function openDbEditor(id: number) {
    setError(null)
    setLoadingEditor(true)
    try {
      const detail = await api<TemplateDetail>(`/api/proposal-templates/${id}`)
      setEditing({
        kind: 'db',
        isNew: false,
        id: detail.id,
        file_name: null,
        original_file_name: null,
        name: detail.name,
        description: detail.description || '',
        html_content: detail.html_content,
        is_active: detail.is_active,
        is_default: detail.is_default,
      })
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingEditor(false)
    }
  }

  async function openFileEditor(fileName: string) {
    setError(null)
    setLoadingEditor(true)
    try {
      const detail = await api<{ file_name: string; name: string; html_content: string }>(
        `/api/proposal-templates/files/${encodeURIComponent(fileName)}`
      )
      setEditing({
        kind: 'file',
        isNew: false,
        id: null,
        file_name: detail.file_name,
        original_file_name: detail.file_name,
        name: detail.name,
        description: '',
        html_content: detail.html_content,
        is_active: true,
        is_default: false,
      })
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingEditor(false)
    }
  }

  function openNew(kind: 'db' | 'file') {
    setNewPickerOpen(false)
    const starterHtml =
      '<!-- Paste your proposal HTML here. Use {{CUSTOMER_COMPANY_NAME}}, {{CEO_NAME}}, {{CUSTOMER_EMAIL}}, or any {{COLUMN_NAME}} from the customers table. -->\n<div style="padding:24px;font-family:Georgia,serif;">\n  <h1>Proposal for {{CUSTOMER_COMPANY_NAME}}</h1>\n  <p>Prepared for {{CEO_NAME}} ({{CUSTOMER_EMAIL}})</p>\n</div>'
    setEditing({
      kind,
      isNew: true,
      id: null,
      file_name: null,
      original_file_name: null,
      name: '',
      description: '',
      html_content: starterHtml,
      is_active: true,
      is_default: false,
    })
  }

  async function save() {
    if (!editing) return
    if (!editing.name.trim()) {
      setError('Name is required.')
      return
    }
    if (!editing.html_content.trim()) {
      setError('HTML content is required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (editing.kind === 'db') {
        const payload = {
          name: editing.name,
          description: editing.description,
          html_content: editing.html_content,
          is_active: editing.is_active,
          is_default: editing.is_default,
        }
        if (editing.isNew) {
          await api('/api/proposal-templates', { method: 'POST', body: JSON.stringify(payload) })
        } else {
          await api(`/api/proposal-templates/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        }
      } else {
        if (editing.isNew) {
          await api('/api/proposal-templates/files', {
            method: 'POST',
            body: JSON.stringify({ file_name: editing.name, html_content: editing.html_content }),
          })
        } else if (editing.original_file_name) {
          await api(`/api/proposal-templates/files/${encodeURIComponent(editing.original_file_name)}`, {
            method: 'PUT',
            body: JSON.stringify({ html_content: editing.html_content }),
          })
        }
      }
      setEditing(null)
      refresh()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function removeDb(id: number) {
    if (!confirm('Delete this template? This cannot be undone.')) return
    try {
      await api(`/api/proposal-templates/${id}`, { method: 'DELETE' })
      refresh()
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function removeFile(fileName: string) {
    if (!confirm(`Delete public/templates/${fileName}? This cannot be undone.`)) return
    try {
      await api(`/api/proposal-templates/files/${encodeURIComponent(fileName)}`, { method: 'DELETE' })
      refresh()
    } catch (e: any) {
      setError(e.message)
    }
  }

  if (editing) {
    return (
      <TemplateEditor
        editing={editing}
        setEditing={setEditing}
        saving={saving}
        loadingEditor={loadingEditor}
        error={error}
        onSave={save}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {dbTemplates.length} database template{dbTemplates.length === 1 ? '' : 's'} · {fileTemplates.length} file
          template{fileTemplates.length === 1 ? '' : 's'}
        </p>
        <div className="relative">
          <Button onClick={() => setNewPickerOpen((v) => !v)} className="gap-2">
            <Plus className="h-4 w-4" />
            New template
          </Button>
          {newPickerOpen && (
            <div className="absolute right-0 mt-1.5 w-56 rounded-lg border bg-popover shadow-md z-10 overflow-hidden">
              <button
                type="button"
                onClick={() => openNew('db')}
                className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted/60"
              >
                <Database className="h-4 w-4 mt-0.5 text-primary" />
                <span>
                  <span className="block font-medium">Database template</span>
                  <span className="block text-xs text-muted-foreground">Saved in proposal_templates</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => openNew('file')}
                className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-muted/60 border-t"
              >
                <FileCode2 className="h-4 w-4 mt-0.5 text-primary" />
                <span>
                  <span className="block font-medium">File template</span>
                  <span className="block text-xs text-muted-foreground">Saved as .html in public/templates</span>
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loadingList ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading templates…
        </div>
      ) : cards.length === 0 ? (
        <Card className="shadow-sm">
          <CardContent className="py-16 flex flex-col items-center gap-3 text-center">
            <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
              <FileText className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No templates yet</p>
              <p className="text-xs text-muted-foreground">
                Run the seed script to import your existing template, or create one here.
              </p>
            </div>
            <Button size="sm" onClick={() => openNew('db')} className="gap-2 mt-1">
              <Plus className="h-4 w-4" />
              New template
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {cards.map((c) => (
            <Card key={`${c.kind}-${c.id}`} className="shadow-sm hover:shadow-md transition-shadow">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    {c.kind === 'file' ? <FileCode2 className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                  </div>
                  <div className="flex gap-1.5 flex-wrap justify-end">
                    {c.kind === 'db' && c.is_default && (
                      <Badge className="gap-1 bg-amber-100 text-amber-800 hover:bg-amber-100">
                        <Star className="h-3 w-3 fill-amber-500 text-amber-500" />
                        Default
                      </Badge>
                    )}
                    {c.kind === 'db' && !c.is_active && <Badge variant="secondary">Inactive</Badge>}
                    {c.kind === 'file' && (
                      <Badge variant="secondary" className="gap-1 text-[10px]">
                        <FileCode2 className="h-3 w-3" /> file
                      </Badge>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-medium truncate">{c.name}</h3>
                  <p className="text-xs text-muted-foreground line-clamp-2 min-h-[2rem]">
                    {c.kind === 'db' ? c.description || 'No description' : `public/templates/${c.file_name}`}
                  </p>
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">
                    {c.kind === 'db' ? `Updated ${new Date(c.updated_at || c.created_at).toLocaleDateString()}` : 'On disk'}
                  </span>
                  <div className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => (c.kind === 'db' ? openDbEditor(c.id) : openFileEditor(c.file_name))}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => (c.kind === 'db' ? removeDb(c.id) : removeFile(c.file_name))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Visual split editor: code on the left, live preview on the right    */
/* ------------------------------------------------------------------ */

function TemplateEditor({
  editing,
  setEditing,
  saving,
  loadingEditor,
  error,
  onSave,
  onCancel,
}: {
  editing: EditorState
  setEditing: Dispatch<SetStateAction<EditorState | null>>
  saving: boolean
  loadingEditor: boolean
  error: string | null
  onSave: () => void
  onCancel: () => void
}) {
  // Debounce the preview a touch so a fast typist isn't fighting the
  // iframe reflow on every single keystroke.
  const [previewSrc, setPreviewSrc] = useState('')
  useEffect(() => {
    const handle = setTimeout(() => {
      setPreviewSrc(mergePreviewTemplate(editing.html_content, PREVIEW_SAMPLE_DATA))
    }, 250)
    return () => clearTimeout(handle)
  }, [editing.html_content])

  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false)

  function patch(fields: Partial<EditorState>) {
    setEditing((prev) => (prev ? { ...prev, ...fields } : prev))
  }

  return (
    <div className="space-y-4">
      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between border-b pb-4">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              {editing.kind === 'file' ? (
                <FileCode2 className="h-4 w-4 text-primary" />
              ) : (
                <Database className="h-4 w-4 text-primary" />
              )}
              {editing.isNew
                ? editing.kind === 'file'
                  ? 'New file template'
                  : 'New database template'
                : `Edit template`}
            </CardTitle>
            <CardDescription>
              {editing.isNew
                ? editing.kind === 'file'
                  ? 'Saved as a .html file in public/templates.'
                  : 'Create a reusable proposal template.'
                : editing.kind === 'file'
                ? `public/templates/${editing.original_file_name}`
                : editing.name}
            </CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={onCancel}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4 pt-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="t-name">{editing.kind === 'file' ? 'File name' : 'Name'}</Label>
              <Input
                id="t-name"
                value={editing.name}
                disabled={editing.kind === 'file' && !editing.isNew}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder={
                  editing.kind === 'file' ? 'e.g. government-psu-proposal' : 'e.g. Government / PSU Proposal'
                }
              />
              {editing.kind === 'file' && (
                <p className="text-[11px] text-muted-foreground">
                  {editing.isNew
                    ? 'Saved as <name>.html — rename isn\'t supported after creation.'
                    : "File names can't be changed here — delete and recreate to rename."}
                </p>
              )}
            </div>
            {editing.kind === 'db' && (
              <div className="space-y-1.5">
                <Label htmlFor="t-desc">Description</Label>
                <Input
                  id="t-desc"
                  value={editing.description}
                  onChange={(e) => patch({ description: e.target.value })}
                  placeholder="Short internal note"
                />
              </div>
            )}
          </div>

          {editing.kind === 'db' && (
            <div className="flex items-center gap-6 rounded-lg border bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-2">
                <Switch
                  id="t-active"
                  checked={editing.is_active}
                  onCheckedChange={(v) => patch({ is_active: v })}
                />
                <Label htmlFor="t-active" className="text-sm font-normal cursor-pointer">
                  Active
                  <span className="block text-xs text-muted-foreground">Selectable in the generator</span>
                </Label>
              </div>
              <Separator orientation="vertical" className="h-8" />
              <div className="flex items-center gap-2">
                <Switch
                  id="t-default"
                  checked={editing.is_default}
                  onCheckedChange={(v) => patch({ is_default: v })}
                />
                <Label htmlFor="t-default" className="text-sm font-normal cursor-pointer">
                  Default
                  <span className="block text-xs text-muted-foreground">Pre-selected on load</span>
                </Label>
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Use <code className="bg-muted px-1 py-0.5 rounded">{'{{CUSTOMER_COMPANY_NAME}}'}</code>,{' '}
            <code className="bg-muted px-1 py-0.5 rounded">{'{{CEO_NAME}}'}</code>,{' '}
            <code className="bg-muted px-1 py-0.5 rounded">{'{{CUSTOMER_EMAIL}}'}</code>, or any{' '}
            <code className="bg-muted px-1 py-0.5 rounded">{'{{COLUMN_NAME}}'}</code> from the customers table. The
            preview on the right fills these with sample data so you can see roughly how a real proposal will look.
          </p>

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Split editor: code left, live preview right */}
      <div
        className={
          isPreviewFullscreen
            ? 'fixed inset-0 z-50 bg-background p-4'
            : 'grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch'
        }
      >
        <Card className={isPreviewFullscreen ? 'hidden' : 'shadow-sm flex flex-col'}>
          <CardHeader className="border-b bg-muted/30 py-2.5 shrink-0">
            <CardTitle className="text-xs font-medium flex items-center gap-2 text-muted-foreground uppercase tracking-wide">
              <FileCode2 className="h-3.5 w-3.5" />
              HTML source
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 flex-1">
            {loadingEditor ? (
              <div className="flex items-center justify-center h-[560px] text-muted-foreground gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : (
              <Textarea
                value={editing.html_content}
                onChange={(e) => patch({ html_content: e.target.value })}
                spellCheck={false}
                className="font-mono text-xs h-[560px] resize-none rounded-none border-0 focus-visible:ring-0"
                placeholder="Paste or write your proposal HTML here…"
              />
            )}
          </CardContent>
        </Card>

        <Card className={isPreviewFullscreen ? 'shadow-sm h-full flex flex-col' : 'shadow-sm flex flex-col overflow-hidden'}>
          <CardHeader className="border-b bg-muted/30 py-2.5 shrink-0">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs font-medium flex items-center gap-2 text-muted-foreground uppercase tracking-wide">
                <Eye className="h-3.5 w-3.5" />
                Live preview
              </CardTitle>
              <div className="flex items-center gap-1">
                <Badge variant="outline" className="text-[10px] font-normal">
                  Sample data
                </Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  title={isPreviewFullscreen ? 'Exit full screen' : 'Full screen'}
                  onClick={() => setIsPreviewFullscreen((v) => !v)}
                >
                  {isPreviewFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0 bg-[#e9ebef] flex-1 min-h-0">
            <iframe
              title="Template live preview"
              srcDoc={previewSrc}
              sandbox=""
              className={isPreviewFullscreen ? 'w-full h-full bg-white' : 'w-full h-[560px] bg-white'}
            />
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-2">
        <Button disabled={saving || !editing.name || !editing.html_content} onClick={onSave} className="gap-2">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save template'}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
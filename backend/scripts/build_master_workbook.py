#!/usr/bin/env python3
"""Build one detailed master workbook from all source-engine workbooks.
Preserves every source column while adding standardized prospect, company,
and evidence sheets modeled on the supplied reference workbooks.
"""
import argparse, json, os, re
from datetime import datetime, timezone
from collections import defaultdict
import openpyxl
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

SOFTWARE_DOMAINS={
 'custom software development','web & mobile application development','system integration & it modernization',
 'cloud & saas application development','enterprise application development (erp/crm)',
 'software maintenance & support','api & middleware development','related software/it development',
 'it / ict','software development','cloud & infrastructure','data & analytics','enterprise systems','digital transformation'
}

def s(v):
    if v is None: return ''
    if isinstance(v,(dict,list)): return json.dumps(v, ensure_ascii=False)
    return str(v).strip()

def get(row,*names):
    for n in names:
        if n in row and s(row[n]): return row[n]
        u=n.upper()
        for k,v in row.items():
            if str(k).upper()==u and s(v): return v
    return ''

def category(row):
    explicit=s(get(row,'TENDER_CATEGORY','CATEGORY')).upper()
    if explicit in {'SOFTWARE','APPLICATION','APPLICATIONS'}: return 'APPLICATIONS'
    if explicit in {'DIGITIZATION','DIGITISATION','SCANNING'}: return 'DIGITIZATION'
    d=s(get(row,'DOMAIN')).lower()
    if d in SOFTWARE_DOMAINS: return 'APPLICATIONS'
    if d: return 'DIGITIZATION'
    return 'OTHER'

def read_source(path):
    out={'live':[],'sub':[]}
    wb=load_workbook(path, read_only=True, data_only=True)
    for kind, sheet in [('live','LIVE_TENDERS'),('sub','SUBCONTRACTING_TENDERS')]:
        if sheet not in wb.sheetnames: continue
        ws=wb[sheet]
        rows=ws.iter_rows(values_only=True)
        try: headers=[s(x) for x in next(rows)]
        except StopIteration: continue
        for vals in rows:
            row={headers[i]: (vals[i] if i<len(vals) else '') for i in range(len(headers)) if headers[i]}
            row['_SOURCE_WORKBOOK']=os.path.basename(path); row['_SOURCE_SHEET']=sheet
            row['_CATEGORY']=category(row)
            out[kind].append(row)
    return out

def uniq_rows(rows, keynames):
    seen=set(); out=[]
    for r in rows:
        key=tuple(s(get(r,*names)) for names in keynames)
        if not any(key):
            key=(s(r.get('_SOURCE_WORKBOOK')), s(r.get('_SOURCE_SHEET')), len(out))
        if key in seen: continue
        seen.add(key); out.append(r)
    return out

def write_sheet(wb,name,rows,preferred=None):
    if not rows:
        rows=[{'STATUS':'No records available'}]
    keys=[]
    if preferred:
        keys.extend([k for k in preferred if any(k in r for r in rows)])
    for r in rows:
        for k in r:
            if k not in keys and not str(k).startswith('_'): keys.append(k)
    # Internal metadata is useful in evidence sheets, not raw category sheets.
    if any('_SOURCE_WORKBOOK' in r for r in rows):
        for k in ['_SOURCE_WORKBOOK','_SOURCE_SHEET','_CATEGORY']:
            if any(k in r for r in rows) and k not in keys: keys.append(k)
    ws=wb.create_sheet(name[:31])
    ws.freeze_panes='A2'; ws.sheet_view.showGridLines=False
    for c,h in enumerate(keys,1):
        cell=ws.cell(1,c,h); cell.font=Font(name='Aptos',size=10,bold=True,color='FFFFFF'); cell.fill=PatternFill('solid',fgColor='1F4E78'); cell.alignment=Alignment(horizontal='center',vertical='center',wrap_text=True)
    ws.row_dimensions[1].height=30
    border=Border(*(Side(style='thin',color='D9E1F2'),)*4)
    for ri,r in enumerate(rows,2):
        for ci,k in enumerate(keys,1):
            v=r.get(k,''); cell=ws.cell(ri,ci,v if not isinstance(v,(dict,list)) else json.dumps(v,ensure_ascii=False)); cell.alignment=Alignment(vertical='top',wrap_text=False); cell.border=border
            if ri%2==0: cell.fill=PatternFill('solid',fgColor='F5F8FC')
            if s(v).startswith(('http://','https://')): cell.hyperlink=s(v); cell.font=Font(name='Aptos',size=10,color='0563C1',underline='single')
    end=max(2,len(rows)+1); ws.auto_filter.ref=f'A1:{get_column_letter(max(1,len(keys)))}{end}'
    for ci,k in enumerate(keys,1):
        vals=[s(r.get(k,'')) for r in rows[:100]]
        mx=min(45,max(12,max([len(k)]+[min(60,len(v)) for v in vals])))
        ws.column_dimensions[get_column_letter(ci)].width=mx+2
    if len(rows)>0:
        ref=f'A1:{get_column_letter(max(1,len(keys)))}{end}'
        try:
            tab=Table(displayName=re.sub(r'[^A-Za-z0-9_]','_',name)[:20]+'Tbl',ref=ref); tab.tableStyleInfo=TableStyleInfo(name='TableStyleMedium2',showRowStripes=True,showColumnStripes=False); ws.add_table(tab)
        except Exception: pass
    return ws

def build(data_dir, output):
    files=[]
    for fn in os.listdir(data_dir):
        if not fn.lower().endswith('.xlsx') or fn.startswith('~$') or fn==os.path.basename(output): continue
        files.append(os.path.join(data_dir,fn))
    all_live=[]; all_sub=[]
    for f in sorted(files):
        try:
            d=read_source(f); all_live += d['live']; all_sub += d['sub']
        except Exception as e:
            print(f'[MASTER] skipped {f}: {e}')
    all_live=uniq_rows(all_live,[('NOTICE_ID','TENDER_ID / NOTICE_ID','TENDER_ID / NOTICE_ID'),('TENDER_TITLE','TENDER_TITLE')])
    all_sub=uniq_rows(all_sub,[('AWARD_NUMBER','AWARD_NUMBER','TENDER_ID / NOTICE_ID'),('NOTICE_ID','NOTICE_ID','TENDER_ID / NOTICE_ID'),('PRIME_CONTRACTOR','AWARDED_COMPANY','COMPANY_NAME'),('CONTRACT_TITLE','TENDER_TITLE')])
    wb=Workbook(); wb.remove(wb.active)
    live_pref=['TENDER_TITLE','NOTICE_ID','TENDER_ID / NOTICE_ID','SOLICITATION_NUMBER','NOTICE_TYPE','STATUS','AGENCY','CONTRACTING_AUTHORITY','CONTRACTING_OFFICE','DESCRIPTION','DOMAIN','SUBDOMAIN','TENDER_COUNTRY','COUNTRY','PUBLISHED_DATE','POSTED_DATE','DEADLINE','RESPONSE_DEADLINE','TENDER_VALUE / QUOTATION','ESTIMATED_VALUE','CONTRACT_VALUE / QUOTATION','CURRENCY','CPV_CODES','NAICS_CODE','PSC_CODE','ELIGIBILITY_SUMMARY','ORBITAVANYA_ELIGIBILITY','RELEVANCE_SCORE','TENDER_STATUS','TED_URL','SAM_URL','TED / OFFICIAL TENDER URL','TENDER_DOCUMENTS_URL','TENDER_DOCUMENT_URL','PLATFORM / SOURCE','SOURCE_PLATFORM','PROFILE_KEY','PROFILE_COMPANY_NAME']
    sub_pref=['LEAD_ID','SUBCONTRACTOR_OUTREACH_PRIORITY','QUALIFIED_LEAD','MATCH_CONFIDENCE','MATCH_TYPE','COMPANY_NAME','LEGAL_COMPANY_NAME','DISPLAY_NAME','COMPANY_TYPE','COMPANY_STATUS','PARENT_COMPANY','AWARDED_COMPANY','PRIME_CONTRACTOR','OFFICIAL_COMPANY_WEBSITE','VERIFIED_OFFICIAL_WEBSITE','COMPANY_WEBSITE','OFFICIAL_DOMAIN','COMPANY_LINKEDIN','GENERAL_PHONE','GENERAL_EMAILS','ALL_COMPANY_EMAILS','PROCUREMENT_EMAILS','ALL_VERIFIED_PROCUREMENT_EMAILS','ALL_EXECUTIVE_NAMES & ROLES','EXECUTIVE_NAMES_AND_ROLES','ALL_EXECUTIVE_EMAILS','EXECUTIVE_EMAILS','ALL_EXECUTIVE_LINKEDINS','EXECUTIVE_LINKEDINS','PROCUREMENT / CONTRACTS URL','PROCUREMENT_URL','PROCUREMENT / CONTRACTS URL','SUPPLIER_URL','SUPPLIER_VENDOR_URL','SUBCONTRACTING / PARTNER URL','SUBCONTRACTING_URL','PARTNER_TEAMING_URL','TEAMS','TENDER_TITLE','CONTRACT_TITLE','TENDER_ID / NOTICE_ID','NOTICE_ID','AWARD_NUMBER','AGENCY','CONTRACTING_AUTHORITY','CONTRACTING_OFFICE','AWARD_DATE','CONTRACT_START','CONTRACT_START_DATE','CONTRACT_END','CONTRACT_END_DATE','CONTRACT_STATUS','AWARD_VALUE','CONTRACT_VALUE / QUOTATION','TOTAL_CONTRACT_VALUE','CURRENCY','DOMAIN','SUBDOMAIN','LIKELY_SUBCONTRACTABLE_WORK','SUBCONTRACTING_SCOPE_RELEVANCE','SUBCONTRACTING POTENTIAL','WHY CONTACT THIS COMPANY','COMPANY_DESCRIPTION','HEADQUARTERS','CITY','STATE','COUNTRY','NAICS_CODES','PSC_CODES','CPV','TED / OFFICIAL TENDER URL','TED_URL','SAM_URL','USASPENDING_AWARD_URL','SOURCE_PLATFORM','PLATFORM / SOURCE','VERIFICATION_EVIDENCE']
    write_sheet(wb,'LIVE_TENDERS',all_live,live_pref)
    write_sheet(wb,'SUBCONTRACTING',all_sub,sub_pref)
    write_sheet(wb,'APPLICATIONS',[r for r in all_live+all_sub if r['_CATEGORY']=='APPLICATIONS'],sub_pref)
    write_sheet(wb,'DIGITIZATION',[r for r in all_live+all_sub if r['_CATEGORY']=='DIGITIZATION'],sub_pref)
    write_sheet(wb,'OTHER_TENDERS',[r for r in all_live+all_sub if r['_CATEGORY']=='OTHER'],sub_pref)
    # Company summary, keeping the richest value found per company.
    cmap={}
    for r in all_sub:
        name=s(get(r,'COMPANY_NAME','prime_contractor','PRIME_CONTRACTOR','AWARDED_COMPANY','LEGAL_COMPANY_NAME'))
        if not name: continue
        k=name.lower(); base=cmap.setdefault(k,{'COMPANY_NAME':name})
        for out,names in [('LEGAL_COMPANY_NAME',('LEGAL_COMPANY_NAME',)),('OFFICIAL_COMPANY_WEBSITE',('OFFICIAL_COMPANY_WEBSITE','VERIFIED_OFFICIAL_WEBSITE','COMPANY_WEBSITE')),('COMPANY_LINKEDIN',('COMPANY_LINKEDIN',)),('ALL_COMPANY_EMAILS',('ALL_COMPANY_EMAILS','COMPANY_EMAILS','GENERAL_EMAILS')),('ALL_EXECUTIVE_EMAILS',('ALL_EXECUTIVE_EMAILS','EXECUTIVE_EMAILS')),('ALL_EXECUTIVE_LINKEDINS',('ALL_EXECUTIVE_LINKEDINS','EXECUTIVE_LINKEDINS')),('PROCUREMENT_URL',('PROCUREMENT_URL','PROCUREMENT / CONTRACTS URL')),('SUPPLIER_URL',('SUPPLIER_URL','SUPPLIER_VENDOR_URL')),('SUBCONTRACTING_URL',('SUBCONTRACTING_URL','SUBCONTRACTING / PARTNER URL')),('TOTAL_AWARD_VALUE',('TOTAL_AWARD_VALUE','TOTAL_CONTRACT_VALUE')),('LATEST_AWARD_DATE',('LATEST_AWARD_DATE','AWARD_DATE')),('NAICS_CODES',('NAICS_CODES','NAICS_CODE')),('PSC_CODES',('PSC_CODES','PSC_CODE'))]:
            if not s(base.get(out)): base[out]=get(r,*names)
        base['SOURCE_COUNT']=base.get('SOURCE_COUNT',0)+1
    write_sheet(wb,'COMPANY_SUMMARY',list(cmap.values()),['COMPANY_NAME','LEGAL_COMPANY_NAME','OFFICIAL_COMPANY_WEBSITE','COMPANY_LINKEDIN','ALL_COMPANY_EMAILS','ALL_EXECUTIVE_EMAILS','ALL_EXECUTIVE_LINKEDINS','PROCUREMENT_URL','SUPPLIER_URL','SUBCONTRACTING_URL','TOTAL_AWARD_VALUE','LATEST_AWARD_DATE','NAICS_CODES','PSC_CODES','SOURCE_COUNT'])
    tender_rows=[]
    for r in all_live+all_sub:
        tender_rows.append({'TENDER_TITLE':get(r,'TENDER_TITLE','CONTRACT_TITLE'),'TENDER_DESCRIPTION':get(r,'DESCRIPTION'),'TENDER_DOMAIN':get(r,'DOMAIN'),'TENDER_SUBDOMAIN':get(r,'SUBDOMAIN'),'TENDER_RELEVANCE':get(r,'RELEVANCE_SCORE'),'TENDER_RELEVANCE_REASON':get(r,'RELEVANCE_REASON','WHY CONTACT THIS COMPANY','VERIFICATION_EVIDENCE'),'AWARD_VALUE':get(r,'AWARD_VALUE','CONTRACT_VALUE / QUOTATION','ESTIMATED_VALUE'),'CONTRACT_VALUE':get(r,'TOTAL_CONTRACT_VALUE','CONTRACT_VALUE / QUOTATION'),'BUYER':get(r,'AGENCY','CONTRACTING_AUTHORITY'),'AWARDED_SUPPLIER':get(r,'PRIME_CONTRACTOR','AWARDED_COMPANY','COMPANY_NAME'),'AWARD_DATE':get(r,'AWARD_DATE'),'CONTRACT_START_DATE':get(r,'CONTRACT_START_DATE','CONTRACT_START'),'CONTRACT_END_DATE':get(r,'CONTRACT_END_DATE','CONTRACT_END'),'CPV':get(r,'CPV','CPV_CODES','PSC_CODE'),'CPV_DESCRIPTION':get(r,'SUBDOMAIN'),'PLACE_OF_PERFORMANCE':get(r,'LOCATION','TENDER_COUNTRY','COUNTRY'),'ORIGINAL_TENDER_URL':get(r,'SAM_URL','TED_URL','TED / OFFICIAL TENDER URL'),'SOURCE':get(r,'_SOURCE_WORKBOOK')})
    write_sheet(wb,'TENDER_SUMMARY',tender_rows)
    exec_rows=[]; url_rows=[]; source_rows=[]
    for r in all_sub+all_live:
        company=get(r,'COMPANY_NAME','PRIME_CONTRACTOR','AWARDED_COMPANY','LEGAL_COMPANY_NAME','AGENCY','CONTRACTING_AUTHORITY')
        exnames=get(r,'ALL_EXECUTIVE_NAMES & ROLES','EXECUTIVE_NAMES_AND_ROLES')
        exemails=get(r,'ALL_EXECUTIVE_EMAILS','EXECUTIVE_EMAILS'); exlinks=get(r,'ALL_EXECUTIVE_LINKEDINS','EXECUTIVE_LINKEDINS')
        if exnames or exemails or exlinks: exec_rows.append({'COMPANY_NAME':company,'EXECUTIVE_NAME':exnames,'ROLE':'','IDENTITY_SOURCE_URL':get(r,'SOURCE_URL','SAM_URL','TED_URL'),'IDENTITY_SOURCE_TITLE':get(r,'TENDER_TITLE','CONTRACT_TITLE'),'IDENTITY_VERIFIED':get(r,'VERIFICATION_EVIDENCE'),'LINKEDIN_SEARCH_QUERY':'','LINKEDIN_SOURCE_URL':get(r,'COMPANY_LINKEDIN'),'LINKEDIN_PROFILE_URL':exlinks,'LINKEDIN_OPENED':'','LINKEDIN_VERIFIED':'','EMAIL_SEARCH_QUERY':'','EMAIL_SOURCE_URL':get(r,'SOURCE_URL','SAM_URL','TED_URL'),'EMAIL':exemails,'EMAIL_VERIFIED':get(r,'VERIFICATION_EVIDENCE')})
        for label,names in [('Company Website',('OFFICIAL_COMPANY_WEBSITE','VERIFIED_OFFICIAL_WEBSITE','COMPANY_WEBSITE')),('Company LinkedIn',('COMPANY_LINKEDIN',)),('Procurement',('PROCUREMENT_URL','PROCUREMENT / CONTRACTS URL')),('Supplier',('SUPPLIER_URL','SUPPLIER_VENDOR_URL')),('Subcontracting',('SUBCONTRACTING_URL','SUBCONTRACTING / PARTNER URL')),('Tender',('SAM_URL','TED_URL','TED / OFFICIAL TENDER URL'))]:
            u=get(r,*names)
            if u: url_rows.append({'COMPANY_NAME':company,'URL_TYPE':label,'URL':u,'DISCOVERY_QUERY':'','DISCOVERY_SOURCE':s(r.get('_SOURCE_WORKBOOK')),'DISCOVERY_SOURCE_URL':u,'DATE_DISCOVERED':datetime.now(timezone.utc).isoformat(),'OPENED':'','HTTP_STATUS':'','FINAL_URL':u,'PAGE_TITLE':get(r,'TENDER_TITLE','CONTRACT_TITLE'),'DOMAIN':get(r,'DOMAIN'),'ENTITY_MATCH':'','CONTENT_MATCH':'','VERIFIED':get(r,'VERIFICATION_EVIDENCE'),'REJECTION_REASON':''})
        source_rows.append({'COMPANY_NAME':company,'SOURCE_TYPE':s(r.get('_SOURCE_SHEET')),'SOURCE_URL':get(r,'SAM_URL','TED_URL','TED / OFFICIAL TENDER URL'),'DATE_ACCESSED':datetime.now(timezone.utc).date().isoformat(),'CONFIDENCE':get(r,'RELEVANCE_SCORE','MATCH_CONFIDENCE')})
    write_sheet(wb,'EXECUTIVE_EVIDENCE',exec_rows)
    write_sheet(wb,'URL_EVIDENCE',url_rows)
    write_sheet(wb,'SOURCE_INDEX',source_rows)
    dash=[
      {'KPI / METRIC NAME':'Live tenders','DESCRIPTION':'All unique live opportunities from SAM, TED and UK','COUNT / VALUE':len(all_live)},
      {'KPI / METRIC NAME':'Subcontracting prospects','DESCRIPTION':'All unique awarded/ongoing subcontracting opportunities','COUNT / VALUE':len(all_sub)},
      {'KPI / METRIC NAME':'Application records','DESCRIPTION':'Rows classified as application/software','COUNT / VALUE':sum(r['_CATEGORY']=='APPLICATIONS' for r in all_live+all_sub)},
      {'KPI / METRIC NAME':'Digitization records','DESCRIPTION':'Rows classified as digitization/scanning/data services','COUNT / VALUE':sum(r['_CATEGORY']=='DIGITIZATION' for r in all_live+all_sub)},
      {'KPI / METRIC NAME':'Other records','DESCRIPTION':'Rows not confidently classified','COUNT / VALUE':sum(r['_CATEGORY']=='OTHER' for r in all_live+all_sub)},
      {'KPI / METRIC NAME':'Unique companies','DESCRIPTION':'Unique subcontractor/awardee companies','COUNT / VALUE':len(cmap)},
      {'KPI / METRIC NAME':'Generated UTC','DESCRIPTION':'Master workbook generation time','COUNT / VALUE':datetime.now(timezone.utc).isoformat()},
    ]
    write_sheet(wb,'DASHBOARD',dash,['KPI / METRIC NAME','DESCRIPTION','COUNT / VALUE'])
    wb.save(output)
    print(f'[MASTER] saved {output} | live={len(all_live)} sub={len(all_sub)} companies={len(cmap)}')

if __name__=='__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('--data-dir',required=True); ap.add_argument('--output',required=True); a=ap.parse_args(); build(a.data_dir,a.output)
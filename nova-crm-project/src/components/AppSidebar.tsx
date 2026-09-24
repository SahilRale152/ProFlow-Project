import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { FileKey2, ChevronRight } from "lucide-react";
import { ClipboardCheck } from "lucide-react";
import {
  LayoutDashboard, Users, Target, Package, FileText, Bot,
  MessageSquare, BarChart3, Bell, FolderOpen, Settings, LogOut, Sparkles, Database,
  Code2, ScanLine,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarHeader, SidebarFooter, useSidebar,
  SidebarMenuSub, SidebarMenuSubItem, SidebarMenuSubButton,
} from "@/components/ui/sidebar";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { api, clearAuthToken } from "@/lib/auth";
import { cn } from "@/lib/utils";

/* ---------- Types ---------- */

type LeafItem = {
  title: string;
  url: string;
  icon: React.ElementType;
  color: string;
  bg: string;
};

type SubItem = {
  title: string;
  url: string;
  icon?: React.ElementType;
};

type ParentItem = {
  title: string;
  icon: React.ElementType;
  color: string;
  bg: string;
  items: SubItem[];
};

type NavItem = LeafItem | ParentItem;

function isParent(item: NavItem): item is ParentItem {
  return "items" in item;
}

/* ---------- Nav data ---------- */

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview", items: [
      { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard, color: "text-blue-500", bg: "bg-blue-50" },
      { title: "Analytics", url: "/analytics", icon: BarChart3, color: "text-violet-500", bg: "bg-violet-50" },
    ]
  },
  {
    label: "Sales", items: [
      { title: "Customers", url: "/customers", icon: Users, color: "text-emerald-500", bg: "bg-emerald-50" },
      // "SAM Data" is a dropdown containing Software + Scanning-Digitization
      {
        title: "SAM Data",
        icon: Database,
        color: "text-emerald-500",
        bg: "bg-emerald-50",
        items: [
          { title: "Software", url: "/software", icon: Code2 },
          { title: "Scanning-Digitization", url: "/scanning-digitization", icon: ScanLine },
        ],
      },
      { title: "Sales", url: "/Sales", icon: Target, color: "text-orange-500", bg: "bg-orange-50" },
      {
        title: "Tender Customers",
        url: "/tender-customers",
        icon: Database,
        color: "text-violet-500", bg: "bg-violet-50"
      },
    ]
  },
  {
    label: "Client Management",
    items: [
      { title: "Client Contracts", url: "/client-contracts", icon: FileKey2, color: "text-cyan-600", bg: "bg-cyan-50" },
      {
        title: "Client Onboarding",
        url: "/client-onboarding",
        icon: ClipboardCheck,
        color: "text-teal-500",
        bg: "bg-teal-50",
      },
    ],
  },
  {
    label: "AI Studio", items: [
      { title: "Proposals", url: "/proposals", icon: FileText, color: "text-indigo-500", bg: "bg-indigo-50" },
      { title: "AI LLM", url: "/ai-llm", icon: Bot, color: "text-fuchsia-500", bg: "bg-fuchsia-50" },
    ]
  },
  {
    label: "Workspace", items: [
      { title: "Communications", url: "/communications", icon: MessageSquare, color: "text-sky-500", bg: "bg-sky-50" },
      { title: "Documents", url: "/documents", icon: FolderOpen, color: "text-yellow-600", bg: "bg-yellow-50" },
      { title: "Notifications", url: "/notifications", icon: Bell, color: "text-pink-500", bg: "bg-pink-50" },
      { title: "Admin", url: "/admin", icon: Settings, color: "text-slate-500", bg: "bg-slate-100" },
    ]
  },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const qc = useQueryClient();

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    try { await api("/api/auth/logout", { method: "POST" }); } catch { }
    clearAuthToken();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-2 px-2 py-2">
          <div className="h-8 w-8 shrink-0 rounded-lg bg-gradient-primary shadow-glow" />
          {!collapsed && (
            <div>
              <div className="text-sm font-semibold">OrbitAvanya CRM</div>
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Sparkles className="h-2.5 w-2.5 text-accent" /> AI-powered
              </div>
            </div>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((g) => (
          <SidebarGroup key={g.label}>
            {!collapsed && <SidebarGroupLabel>{g.label}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>
                {g.items.map((item) => {
                  if (isParent(item)) {
                    // Active if the pathname matches any of the sub-item urls
                    const childActive = item.items.some(
                      (sub) => pathname === sub.url || pathname.startsWith(sub.url + "/")
                    );

                    return (
                      <Collapsible
                        key={item.title}
                        asChild
                        defaultOpen={childActive}
                        className="group/collapsible"
                      >
                        <SidebarMenuItem>
                          <CollapsibleTrigger asChild>
                            <SidebarMenuButton isActive={childActive} tooltip={item.title}>
                              <span
                                className={cn(
                                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg shadow-[1px_1px_3px_rgba(0,0,0,0.08),-1px_-1px_3px_rgba(255,255,255,0.8)]",
                                  item.bg,
                                )}
                              >
                                <item.icon className={cn("h-3.5 w-3.5", item.color)} aria-hidden="true" />
                              </span>
                              {!collapsed && <span>{item.title}</span>}
                              {!collapsed && (
                                <ChevronRight className="ml-auto h-4 w-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                              )}
                            </SidebarMenuButton>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <SidebarMenuSub>
                              {item.items.map((sub) => {
                                const active = pathname === sub.url || pathname.startsWith(sub.url + "/");
                                const SubIcon = sub.icon;
                                return (
                                  <SidebarMenuSubItem key={sub.url}>
                                    <SidebarMenuSubButton asChild isActive={active}>
                                      <Link to={sub.url} className="flex items-center gap-2">
                                        {SubIcon && <SubIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                                        <span>{sub.title}</span>
                                      </Link>
                                    </SidebarMenuSubButton>
                                  </SidebarMenuSubItem>
                                );
                              })}
                            </SidebarMenuSub>
                          </CollapsibleContent>
                        </SidebarMenuItem>
                      </Collapsible>
                    );
                  }

                  // Regular flat leaf item
                  const active = pathname === item.url || pathname.startsWith(item.url + "/");
                  return (
                    <SidebarMenuItem key={item.url}>
                      <SidebarMenuButton asChild isActive={active}>
                        <Link to={item.url} className="flex items-center gap-2">
                          <span
                            className={cn(
                              "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg shadow-[1px_1px_3px_rgba(0,0,0,0.08),-1px_-1px_3px_rgba(255,255,255,0.8)]",
                              item.bg,
                            )}
                          >
                            <item.icon className={cn("h-3.5 w-3.5", item.color)} aria-hidden="true" />
                          </span>
                          {!collapsed && <span>{item.title}</span>}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={signOut}>
              <LogOut className="h-4 w-4" />
              {!collapsed && <span>Sign out</span>}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
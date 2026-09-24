import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { api } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    try {
      const data = await api("/api/auth/me");
      if (!data?.user) throw new Error("Not authenticated");
      return { user: data.user };
    } catch {
      throw redirect({ to: "/auth" });
    }
  },
  component: Layout,
});

function Layout() {
  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <div className="flex flex-1 flex-col min-w-0">
          <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-border/60 bg-background/60 px-4 backdrop-blur">
            <SidebarTrigger />
            <div className="text-sm text-muted-foreground">OrbitAvanya CRM</div>
          </header>
          <main className="flex-1 min-w-0 overflow-x-hidden p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

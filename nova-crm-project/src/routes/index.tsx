import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Sparkles, Zap, FileText, TrendingUp, Bot, Users, ArrowRight, CheckCircle2 } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "OrbitAvanya CRM — AI Sales & Proposal Generator" },
      { name: "description", content: "Close deals faster with an AI-powered CRM. Auto-generate proposals, score leads, and get real-time sales coaching." },
      { property: "og:title", content: "OrbitAvanya CRM — AI Sales & Proposal Generator" },
      { property: "og:description", content: "Close deals faster with an AI-powered CRM. Auto-generate proposals, score leads, and get real-time sales coaching." },
    ],
  }),
  component: Landing,
});

const features = [
  { icon: Users, title: "Unified CRM", desc: "Customers, leads, and pipeline in one place." },
  { icon: Bot, title: "AI Sales Assistant", desc: "Insights, objection handling, meeting prep." },
  { icon: FileText, title: "AI Proposal Generator", desc: "Studio-grade proposals in seconds." },
  { icon: TrendingUp, title: "Pipeline & Forecasting", desc: "Track deals from Lead → Won." },
  { icon: Sparkles, title: "Smart Lead Scoring", desc: "AI ranks your hottest opportunities." },
  { icon: Zap, title: "Automations", desc: "Follow-up reminders and notifications." },
];

function goToApp() {
  window.location.href = "/auth";
}

function Landing() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-xl bg-gradient-primary shadow-glow" />
          <span className="text-lg font-semibold tracking-tight">OrbitAvanya CRM</span>
        </div>
        <nav className="hidden gap-6 md:flex">
          <a href="#features" className="text-sm text-muted-foreground hover:text-foreground">Features</a>
          <a href="#workflow" className="text-sm text-muted-foreground hover:text-foreground">Workflow</a>
          <a href="#pricing" className="text-sm text-muted-foreground hover:text-foreground">Pricing</a>
        </nav>
        <Link to="/auth" className="rounded-md bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow">Sign in</Link>
      </header>

      <section className="mx-auto max-w-7xl px-6 pb-20 pt-16 text-center">
        <h1 className="mx-auto max-w-4xl text-5xl font-bold leading-[1.05] tracking-tight md:text-7xl">
          The <span className="text-gradient">AI CRM</span> that writes your proposals for you.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
          OrbitAvanya unifies your customers, leads, and pipeline — then uses AI to generate winning proposals, score leads, and coach every deal.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <button onClick={goToApp} className="inline-flex items-center gap-2 rounded-lg bg-gradient-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow-glow">
            Get started <ArrowRight className="h-4 w-4" />
          </button>
          <a href="#features" className="rounded-lg border border-border px-6 py-3 text-sm">See features</a>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-7xl px-6 py-16">
        <div className="grid gap-4 md:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="glass rounded-2xl p-6 shadow-elegant">
              <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-primary shadow-glow">
                <f.icon className="h-5 w-5 text-primary-foreground" />
              </div>
              <h3 className="text-lg font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="workflow" className="mx-auto max-w-5xl px-6 py-16">
        <h2 className="text-center text-3xl font-bold md:text-4xl">From <span className="text-gradient">Lead</span> to <span className="text-gradient">Won</span></h2>
        <div className="mt-10 grid gap-3 md:grid-cols-6">
          {["Lead", "Qualified", "Proposal Sent", "Negotiation", "Won", "Analytics"].map((s, i) => (
            <div key={s} className="glass rounded-xl p-4 text-center text-sm">
              <div className="text-xs text-muted-foreground">Stage {i + 1}</div>
              <div className="mt-1 font-semibold">{s}</div>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="mx-auto max-w-3xl px-6 py-20 text-center">
        <div className="glass rounded-3xl p-10 shadow-elegant">
          <h2 className="text-3xl font-bold">Start closing more deals today</h2>
          <p className="mt-2 text-muted-foreground">Free to try. No credit card required.</p>
          <ul className="mx-auto mt-6 max-w-md space-y-2 text-left text-sm">
            {["AI proposal generator", "Lead scoring & insights", "Pipeline forecasting", "Team collaboration"].map((x) => (
              <li key={x} className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-accent" /> {x}</li>
            ))}
          </ul>
          <button onClick={goToApp} className="mt-8 rounded-lg bg-gradient-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow-glow">
            Launch OrbitAvanya CRM
          </button>
        </div>
      </section>

      <footer className="border-t border-border/60 py-8 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} OrbitAvanya CRM. All rights reserved.
      </footer>
    </div>
  );
}

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const ProposalInput = z.object({
  customerName: z.string().min(1).max(200),
  customerIndustry: z.string().max(200).optional().default(""),
  products: z.string().max(4000),
  budget: z.string().max(200).optional().default(""),
  timeline: z.string().max(200).optional().default(""),
  requirements: z.string().max(4000),
});

export const generateProposal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => ProposalInput.parse(v))
  .handler(async ({ data }) => {
    const { aiComplete } = await import("./ai-gateway.server");
    const system = `You are an expert B2B proposal writer. Produce a polished business proposal in Markdown with these sections:
# Executive Summary
## About the Client
## Understanding Your Needs
## Proposed Solution
## Scope & Deliverables
## Timeline
## Pricing Overview
## Why Us
## Terms & Conditions
## Next Steps
Be persuasive, specific, and professional. Use bullet lists and short paragraphs.`;
    const user = `Client: ${data.customerName}
Industry: ${data.customerIndustry}
Products/Services offered: ${data.products}
Client budget: ${data.budget}
Desired timeline: ${data.timeline}
Requirements: ${data.requirements}`;
    const content = await aiComplete(system, user);
    return { content };
  });

const AssistantInput = z.object({
  mode: z.enum(["insight", "strategy", "email", "objection", "meeting_prep"]),
  context: z.string().max(6000),
});

export const askAssistant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => AssistantInput.parse(v))
  .handler(async ({ data }) => {
    const { aiComplete } = await import("./ai-gateway.server");
    const prompts: Record<typeof data.mode, string> = {
      insight: "You are an AI sales analyst. Summarize key customer insights and buying signals. Be concrete.",
      strategy: "You are a senior sales strategist. Recommend a step-by-step sales strategy tailored to the context.",
      email: "You are a top-performing SDR. Write a concise, personalized outreach email (subject + body).",
      objection: "You are a sales coach. List the top 3 likely objections and confident, empathetic responses.",
      meeting_prep: "You are a sales coach. Produce a meeting prep brief: agenda, discovery questions, and success criteria.",
    };
    const content = await aiComplete(prompts[data.mode], data.context);
    return { content };
  });

const ScoreInput = z.object({ context: z.string().max(4000) });
export const scoreLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => ScoreInput.parse(v))
  .handler(async ({ data }) => {
    const { aiComplete } = await import("./ai-gateway.server");
    const raw = await aiComplete(
      "You score sales leads. Respond ONLY as JSON: {\"score\": 0-100, \"reason\": \"...\"}",
      data.context,
    );
    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      return { score: Math.max(0, Math.min(100, Number(parsed.score) || 0)), reason: String(parsed.reason || "") };
    } catch {
      return { score: 50, reason: raw.slice(0, 400) };
    }
  });

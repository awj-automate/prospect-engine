import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { generateBrief, type BriefProgress } from "@/lib/brief";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Railway has no serverless timeout; run the pipeline inline and stream progress.
export const maxDuration = 800;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const [lead] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
  if (!lead) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (p: BriefProgress) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(p)}\n\n`));
        } catch {
          /* controller closed */
        }
      };

      try {
        await generateBrief(id, send);
      } catch (err) {
        send({
          step: "error",
          message: "Brief generation failed.",
          error: err instanceof Error ? err.message : "unknown error",
          done: true,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

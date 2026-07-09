"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Sparkles, Loader2, ExternalLink } from "lucide-react";
import type { ResearchBriefRow } from "@/lib/db/schema";
import type { ResearchCitation } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmtRelative } from "@/lib/format";

interface Progress {
  step: string;
  message: string;
  done?: boolean;
  error?: string;
}

export function ResearchBrief({
  leadId,
  latestBrief,
  onComplete,
}: {
  leadId: string;
  latestBrief: ResearchBriefRow | null;
  onComplete: () => void;
}) {
  const [streaming, setStreaming] = useState(false);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setStreaming(true);
    setProgress([]);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/research`, { method: "POST" });
      if (!res.ok || !res.body) {
        setError("Failed to start generation.");
        setStreaming(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.trim();
          if (!line.startsWith("data:")) continue;
          try {
            const evt = JSON.parse(line.slice(5).trim()) as Progress;
            setProgress((p) => [...p, evt]);
            if (evt.error) setError(evt.error);
          } catch {
            /* ignore malformed line */
          }
        }
      }
    } catch {
      setError("Streaming connection dropped.");
    } finally {
      setStreaming(false);
      onComplete();
    }
  }

  const isGenerating = streaming || latestBrief?.status === "generating";
  const citations = (latestBrief?.citations ?? []) as ResearchCitation[];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" />
          Research Brief
          {latestBrief?.status === "done" && latestBrief.completedAt && (
            <span className="text-xs font-normal text-muted-foreground">
              generated {fmtRelative(latestBrief.completedAt)}
            </span>
          )}
        </CardTitle>
        <Button size="sm" onClick={generate} disabled={isGenerating}>
          {isGenerating ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {latestBrief ? "Regenerate" : "Generate brief"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {(streaming || progress.length > 0) && (
          <div className="space-y-1 rounded-md border bg-muted/40 p-3">
            {progress.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                {p.done ? (
                  p.error ? (
                    <span className="text-destructive">✕</span>
                  ) : (
                    <span className="text-emerald-500">✓</span>
                  )
                ) : (
                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                )}
                <span className={p.error ? "text-destructive" : "text-muted-foreground"}>{p.message}</span>
              </div>
            ))}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        {latestBrief?.status === "failed" && !streaming && (
          <p className="text-sm text-destructive">Last brief failed: {latestBrief.error}</p>
        )}

        {latestBrief?.content ? (
          <>
            <div className="prose-brief max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{latestBrief.content}</ReactMarkdown>
            </div>
            {citations.length > 0 && (
              <div className="space-y-1 border-t pt-3">
                <div className="text-xs font-medium text-muted-foreground">Sources</div>
                <div className="flex flex-wrap gap-2">
                  {citations.map((c, i) => (
                    <a
                      key={i}
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {c.title.length > 50 ? c.title.slice(0, 50) + "…" : c.title}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          !isGenerating &&
          progress.length === 0 && (
            <div className="rounded-md border border-dashed p-6 text-center">
              <Badge variant="muted" className="mb-2">
                No brief yet
              </Badge>
              <p className="text-sm text-muted-foreground">
                Generate an AI research brief: enrichment → web research → a tailored outreach angle.
              </p>
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}

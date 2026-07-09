"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Building2,
  Mail,
  Phone,
  Linkedin,
  UserRound,
  Loader2,
  Briefcase,
  GraduationCap,
} from "lucide-react";
import type { LeadRow, ResearchBriefRow, EnrichmentJobRow } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ResearchBrief } from "@/components/research-brief";
import { fmtRelative, scoreColor, icpFitVariant, fmtNum } from "@/lib/format";

interface DetailResponse {
  lead: LeadRow;
  latestBrief: ResearchBriefRow | null;
  briefs: ResearchBriefRow[];
  jobs: EnrichmentJobRow[];
}

function jobBadgeVariant(status: string): "success" | "warning" | "muted" | "destructive" {
  if (status === "done") return "success";
  if (status === "failed") return "destructive";
  if (status === "processing") return "warning";
  return "muted";
}

export default function LeadDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["lead", id],
    queryFn: async (): Promise<DetailResponse> => {
      const res = await fetch(`/api/leads/${id}`);
      if (!res.ok) throw new Error("failed to load lead");
      return res.json();
    },
    refetchInterval: (query) => {
      const d = query.state.data as DetailResponse | undefined;
      if (!d) return false;
      const active =
        d.jobs.some((j) => j.status === "pending" || j.status === "processing") ||
        d.latestBrief?.status === "generating";
      return active ? 4_000 : false;
    },
  });

  const enrich = useMutation({
    mutationFn: async (kind: string) => {
      const res = await fetch(`/api/leads/${id}/enrich`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      if (!res.ok) throw new Error("enrich failed");
      return res.json();
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["lead", id] }),
  });

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const { lead } = data;
  const company = lead.companyEnriched;
  const person = lead.personEnriched;
  const companyDisplay = company?.name ?? person?.experience?.[0]?.company ?? "—";

  return (
    <div className="space-y-6">
      <Link href="/leads" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to leads
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{lead.name ?? "Unknown lead"}</h1>
          <p className="text-muted-foreground">{lead.title ?? person?.basic?.headline ?? "—"}</p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {lead.icpFit && <Badge variant={icpFitVariant(lead.icpFit)}>ICP: {lead.icpFit}</Badge>}
            {lead.connectionStatus && <Badge variant="outline">{lead.connectionStatus}</Badge>}
            {lead.source && <Badge variant="muted">{lead.source}</Badge>}
            {lead.linkedinUrl && (
              <a
                href={lead.linkedinUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                <Linkedin className="h-4 w-4" /> Profile
              </a>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className={`text-4xl font-bold tabular-nums ${scoreColor(lead.score)}`}>{fmtNum(lead.score)}</div>
          <div className="text-xs text-muted-foreground">priority score</div>
        </div>
      </div>

      {/* Enrichment actions */}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => enrich.mutate("person")} disabled={enrich.isPending}>
          <UserRound className="h-4 w-4" /> Enrich person
        </Button>
        <Button size="sm" variant="outline" onClick={() => enrich.mutate("company")} disabled={enrich.isPending}>
          <Building2 className="h-4 w-4" /> Enrich company
        </Button>
        <Button size="sm" variant="outline" onClick={() => enrich.mutate("contact")} disabled={enrich.isPending}>
          <Mail className="h-4 w-4" /> Find contact
        </Button>
        {enrich.isPending && <Loader2 className="h-4 w-4 animate-spin self-center text-muted-foreground" />}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <ResearchBrief
            leadId={id}
            latestBrief={data.latestBrief}
            onComplete={() => qc.invalidateQueries({ queryKey: ["lead", id] })}
          />

          {/* Person enrichment */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <UserRound className="h-4 w-4" /> Person
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {person ? (
                <>
                  {person.about && <p className="text-muted-foreground">{person.about}</p>}
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Location" value={person.basic?.location} />
                    <Field label="Headline" value={person.basic?.headline} />
                    <Field label="Followers" value={person.basic?.follower_count?.toLocaleString()} />
                    <Field label="Connections" value={person.basic?.connections_count?.toLocaleString()} />
                  </div>
                  {person.experience?.length > 0 && (
                    <div>
                      <div className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                        <Briefcase className="h-3 w-3" /> Experience
                      </div>
                      <ul className="space-y-1">
                        {person.experience.slice(0, 5).map((e, i) => (
                          <li key={i} className="text-sm">
                            <span className="font-medium">{e.position ?? "—"}</span>
                            {e.company && <span className="text-muted-foreground"> · {e.company}</span>}
                            {(e.start || e.end) && (
                              <span className="text-xs text-muted-foreground">
                                {" "}
                                ({e.start ?? "?"}–{e.end ?? "present"})
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {person.education?.length > 0 && (
                    <div>
                      <div className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                        <GraduationCap className="h-3 w-3" /> Education
                      </div>
                      <ul className="space-y-1">
                        {person.education.slice(0, 3).map((e, i) => (
                          <li key={i} className="text-sm">
                            {e.school ?? "—"}
                            {e.degree && <span className="text-muted-foreground"> · {e.degree}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground">
                  Not enriched yet. {lead.linkedinUsername ? "Queued or run “Enrich person”." : "No LinkedIn username on file."}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Company enrichment */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Building2 className="h-4 w-4" /> Company — {companyDisplay}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {company ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Industry" value={company.industry} />
                  <Field label="Size" value={company.company_size} />
                  <Field label="HQ" value={company.headquarters} />
                  <Field label="Founded" value={company.founded_year?.toString()} />
                  <Field label="Followers" value={company.follower_count?.toLocaleString()} />
                  <Field label="Slug" value={lead.companySlug} />
                </div>
              ) : (
                <p className="text-muted-foreground">
                  Not enriched yet. {lead.companySlug ? "Queued." : "Enrich person first to resolve the employer."}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Engagement history */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Engagement history</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {(lead.topSignals?.length ?? 0) > 0 || (lead.engagements?.length ?? 0) > 0 ? (
                <ul className="space-y-1">
                  {(lead.topSignals ?? []).slice(0, 6).map((s, i) => (
                    <li key={`s${i}`} className="flex items-center justify-between">
                      <span className="capitalize">{s.type}</span>
                      <span className="text-xs text-muted-foreground">{fmtRelative(s.date)}</span>
                    </li>
                  ))}
                  {(lead.topSignals?.length ?? 0) === 0 &&
                    (lead.engagements ?? []).slice(0, 6).map((e, i) => (
                      <li key={`e${i}`} className="flex items-center justify-between">
                        <span className="capitalize">{e.type ?? "engagement"}</span>
                        <span className="text-xs text-muted-foreground">{fmtRelative(e.date)}</span>
                      </li>
                    ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">No engagement signals recorded.</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Contact</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-muted-foreground" />
                {lead.email ? (
                  <a href={`mailto:${lead.email}`} className="text-primary hover:underline">
                    {lead.email}
                  </a>
                ) : (
                  <span className="text-muted-foreground">No email</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <span className={lead.phone ? "" : "text-muted-foreground"}>{lead.phone ?? "No phone"}</span>
              </div>
              {lead.contactSource && (
                <p className="text-xs text-muted-foreground">via {lead.contactSource}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Score breakdown</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {lead.scoreBreakdown ? (
                (["icp", "heat", "recency", "intent"] as const).map((k) => {
                  const max = { icp: 40, heat: 30, recency: 20, intent: 10 }[k];
                  const v = lead.scoreBreakdown![k] ?? 0;
                  return (
                    <div key={k}>
                      <div className="flex justify-between text-xs">
                        <span className="capitalize">{k}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {v.toFixed(1)} / {max}
                        </span>
                      </div>
                      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div className="h-full bg-primary" style={{ width: `${Math.min(100, (v / max) * 100)}%` }} />
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-muted-foreground">Run a sync to compute score.</p>
              )}
              <Separator />
              <div className="grid grid-cols-2 gap-2 text-xs">
                <Field label="ICP score" value={lead.icpScore != null ? lead.icpScore.toFixed(2) : null} />
                <Field label="Heat" value={lead.heatScore != null ? fmtNum(lead.heatScore) : null} />
                <Field label="Signals" value={lead.signalCount?.toString()} />
                <Field label="Last eng." value={fmtRelative(lead.lastEngagementAt)} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Enrichment jobs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.jobs.length > 0 ? (
                data.jobs.map((j) => (
                  <div key={j.id} className="flex items-center justify-between text-sm">
                    <span className="capitalize">{j.kind.replace("_", " ")}</span>
                    <Badge variant={jobBadgeVariant(j.status)}>{j.status}</Badge>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No jobs queued.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{value || "—"}</div>
    </div>
  );
}

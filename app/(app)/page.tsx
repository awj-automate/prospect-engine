"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Flame, Users, FileText, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtRelative, fmtNum } from "@/lib/format";

interface Stats {
  totals: { leads: number; hot: number; briefs: number };
  usage: {
    date: string;
    person: { used: number; cap: number; remaining: number };
    company: { used: number; cap: number; remaining: number };
  };
  queue: { pending: number; processing: number; failed: number; byKind: Record<string, number> };
  window: {
    inWindow: boolean;
    hour: number;
    start: number;
    end: number;
    elapsedFraction: number;
    expected: { person: number; company: number };
  };
  lastSync: {
    startedAt: string;
    finishedAt: string | null;
    status: string;
    leadsUpserted: number;
    signalsUpdated: number;
    error: string | null;
  } | null;
}

async function fetchStats(): Promise<Stats> {
  const res = await fetch("/api/stats");
  if (!res.ok) throw new Error("failed to load stats");
  return res.json();
}

function StatCard({
  title,
  value,
  icon: Icon,
  sub,
}: {
  title: string;
  value: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  sub?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["stats"],
    queryFn: fetchStats,
    refetchInterval: 10_000,
  });

  const sync = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/sync", { method: "POST" });
      if (!res.ok) throw new Error("sync failed");
      return res.json();
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["stats"] }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {data?.lastSync
              ? `Last sync ${fmtRelative(data.lastSync.startedAt)} · ${data.lastSync.status}`
              : "No sync has run yet"}
          </p>
        </div>
        <Button onClick={() => sync.mutate()} disabled={sync.isPending}>
          <RefreshCw className={sync.isPending ? "animate-spin" : ""} />
          {sync.isPending ? "Syncing…" : "Sync now"}
        </Button>
      </div>

      {sync.isError && <p className="text-sm text-destructive">Sync failed. Check worker/API logs.</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading || !data ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)
        ) : (
          <>
            <StatCard title="Total leads" value={fmtNum(data.totals.leads)} icon={Users} />
            <StatCard title="Hot (≥70)" value={fmtNum(data.totals.hot)} icon={Flame} sub="Highest-priority prospects" />
            <StatCard
              title="Person enriched today"
              value={`${data.usage.person.used}/${data.usage.person.cap}`}
              icon={Activity}
              sub={`${data.usage.person.remaining} left · pace target ${data.window.expected.person}`}
            />
            <StatCard
              title="Company enriched today"
              value={`${data.usage.company.used}/${data.usage.company.cap}`}
              icon={Activity}
              sub={`${data.usage.company.remaining} left · pace target ${data.window.expected.company}`}
            />
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Queue depth</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!data ? (
              <Skeleton className="h-16" />
            ) : (
              <>
                <div className="flex gap-4 text-sm">
                  <div>
                    <div className="text-2xl font-bold">{data.queue.pending}</div>
                    <div className="text-xs text-muted-foreground">pending</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold">{data.queue.processing}</div>
                    <div className="text-xs text-muted-foreground">processing</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-destructive">{data.queue.failed}</div>
                    <div className="text-xs text-muted-foreground">failed</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(data.queue.byKind).map(([kind, n]) => (
                    <Badge key={kind} variant="muted">
                      {kind}: {n}
                    </Badge>
                  ))}
                  {Object.keys(data.queue.byKind).length === 0 && (
                    <span className="text-xs text-muted-foreground">No pending jobs</span>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Enrichment window</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!data ? (
              <Skeleton className="h-16" />
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Badge variant={data.window.inWindow ? "success" : "muted"}>
                    {data.window.inWindow ? "Open" : "Closed"}
                  </Badge>
                  <span className="text-muted-foreground">
                    {String(data.window.start).padStart(2, "0")}:00–{String(data.window.end).padStart(2, "0")}:00 ·
                    now {data.window.hour.toFixed(1)}h
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${Math.round(data.window.elapsedFraction * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {Math.round(data.window.elapsedFraction * 100)}% of window elapsed
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Briefs generated</CardTitle>
          </CardHeader>
          <CardContent>
            {!data ? (
              <Skeleton className="h-16" />
            ) : (
              <div className="flex items-center gap-3">
                <FileText className="h-8 w-8 text-muted-foreground" />
                <div className="text-3xl font-bold">{fmtNum(data.totals.briefs)}</div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

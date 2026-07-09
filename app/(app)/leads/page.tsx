"use client";

import { useState } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search, Mail, CheckCircle2, ChevronRight } from "lucide-react";
import type { LeadRow } from "@/lib/db/schema";
import type { ScoreBreakdown } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmtRelative, scoreColor, icpFitVariant, fmtNum } from "@/lib/format";

interface LeadsResponse {
  data: LeadRow[];
  pagination: { total: number; page: number; pageSize: number; totalPages: number };
}

interface Filters {
  search: string;
  minScore: string;
  icp_fit: string;
  enriched: string;
  has_email: string;
  sort: string;
  dir: string;
  page: number;
}

const DEFAULT: Filters = {
  search: "",
  minScore: "",
  icp_fit: "all",
  enriched: "all",
  has_email: "all",
  sort: "score",
  dir: "desc",
  page: 1,
};

function buildParams(f: Filters): string {
  const p = new URLSearchParams();
  if (f.search) p.set("search", f.search);
  if (f.minScore) p.set("minScore", f.minScore);
  if (f.icp_fit !== "all") p.set("icp_fit", f.icp_fit);
  if (f.enriched !== "all") p.set("enriched", f.enriched);
  if (f.has_email !== "all") p.set("has_email", f.has_email);
  p.set("sort", f.sort);
  p.set("dir", f.dir);
  p.set("page", String(f.page));
  p.set("pageSize", "50");
  return p.toString();
}

function ScoreCell({ score, breakdown }: { score: number | null; breakdown: ScoreBreakdown | null }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={`font-semibold tabular-nums ${scoreColor(score)}`}>{fmtNum(score)}</button>
      </PopoverTrigger>
      <PopoverContent className="w-56" align="start">
        <div className="space-y-2 text-sm">
          <div className="font-medium">Score breakdown</div>
          {breakdown ? (
            <div className="space-y-1">
              {(["icp", "heat", "recency", "intent"] as const).map((k) => {
                const max = { icp: 40, heat: 30, recency: 20, intent: 10 }[k];
                const v = breakdown[k] ?? 0;
                return (
                  <div key={k}>
                    <div className="flex justify-between text-xs">
                      <span className="capitalize">{k}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {v.toFixed(1)} / {max}
                      </span>
                    </div>
                    <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full bg-primary" style={{ width: `${Math.min(100, (v / max) * 100)}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No breakdown yet — run a sync.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function companyName(lead: LeadRow): string {
  return (
    lead.companyEnriched?.name ??
    lead.personEnriched?.experience?.[0]?.company ??
    "—"
  );
}

export default function LeadsPage() {
  const [filters, setFilters] = useState<Filters>(DEFAULT);
  const [searchInput, setSearchInput] = useState("");

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["leads", filters],
    queryFn: async (): Promise<LeadsResponse> => {
      const res = await fetch(`/api/leads?${buildParams(filters)}`);
      if (!res.ok) throw new Error("failed to load leads");
      return res.json();
    },
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
  });

  function update(patch: Partial<Filters>) {
    setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">
            {data ? `${fmtNum(data.pagination.total)} leads` : "Loading…"}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            update({ search: searchInput });
          }}
        >
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search name, title, company…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-64 pl-8"
            />
          </div>
          <Button type="submit" variant="secondary" size="sm">
            Search
          </Button>
        </form>

        <Input
          type="number"
          placeholder="Min score"
          value={filters.minScore}
          onChange={(e) => update({ minScore: e.target.value })}
          className="w-28"
        />

        <Select value={filters.icp_fit} onValueChange={(v) => update({ icp_fit: v })}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="ICP fit" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All fit</SelectItem>
            <SelectItem value="fit">Fit</SelectItem>
            <SelectItem value="maybe">Maybe</SelectItem>
            <SelectItem value="not">Not</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filters.enriched} onValueChange={(v) => update({ enriched: v })}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Enriched" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any enrichment</SelectItem>
            <SelectItem value="y">Enriched</SelectItem>
            <SelectItem value="n">Not enriched</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filters.has_email} onValueChange={(v) => update({ has_email: v })}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Email" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any email</SelectItem>
            <SelectItem value="y">Has email</SelectItem>
            <SelectItem value="n">No email</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filters.sort} onValueChange={(v) => update({ sort: v })}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="score">Score</SelectItem>
            <SelectItem value="heat">Heat</SelectItem>
            <SelectItem value="last_engagement">Last engagement</SelectItem>
            <SelectItem value="icp">ICP score</SelectItem>
            <SelectItem value="name">Name</SelectItem>
            <SelectItem value="created">Created</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name / Title</TableHead>
              <TableHead>Company</TableHead>
              <TableHead className="w-20">Score</TableHead>
              <TableHead className="w-20">ICP</TableHead>
              <TableHead className="w-16">Heat</TableHead>
              <TableHead className="w-32">Last eng.</TableHead>
              <TableHead className="w-24">Enriched</TableHead>
              <TableHead className="w-16">Email</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={9}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : data && data.data.length > 0 ? (
              data.data.map((lead) => (
                <TableRow key={lead.id} className="cursor-pointer">
                  <TableCell>
                    <Link href={`/leads/${lead.id}`} className="block">
                      <div className="font-medium">{lead.name ?? "Unknown"}</div>
                      <div className="text-xs text-muted-foreground">{lead.title ?? "—"}</div>
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm">{companyName(lead)}</TableCell>
                  <TableCell>
                    <ScoreCell score={lead.score} breakdown={lead.scoreBreakdown} />
                  </TableCell>
                  <TableCell>
                    {lead.icpFit ? (
                      <Badge variant={icpFitVariant(lead.icpFit)}>{lead.icpFit}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums text-sm">{lead.heatScore != null ? fmtNum(lead.heatScore) : "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{fmtRelative(lead.lastEngagementAt)}</TableCell>
                  <TableCell>
                    {lead.personEnrichedAt ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {lead.email ? <Mail className="h-4 w-4 text-emerald-500" /> : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <Link href={`/leads/${lead.id}`}>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                  No leads match these filters. Run a sync to pull leads from LeadShark.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {data.pagination.page} of {data.pagination.totalPages}
            {isFetching && " · updating…"}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page <= 1}
              onClick={() => update({ page: filters.page - 1 })}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page >= data.pagination.totalPages}
              onClick={() => update({ page: filters.page + 1 })}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

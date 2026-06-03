import Link from "next/link";
import type { SessionUser } from "@/lib/auth";
import { requireSession } from "@/lib/auth";
import { statusLabels, priorityLabels } from "@/lib/tickets";
import { TicketsLayout } from "@/components/tickets/TicketsLayout";
import { prisma } from "@/lib/db";
import { andTicketScope, ticketWhereForUser } from "@/lib/ticket-scope";
import { DonutChart, type DonutSegment } from "@/components/dashboard/DonutChart";
import { AreaSparkline } from "@/components/dashboard/AreaSparkline";

export const dynamic = "force-dynamic";

type Stats = NonNullable<Awaited<ReturnType<typeof getDashboardStats>>>;

function pctTrend(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

async function getDashboardStats(user: SessionUser) {
  try {
    const tw = ticketWhereForUser(user);

    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(today.getDate() - 7);

    const fourteenDaysAgo = new Date(today);
    fourteenDaysAgo.setDate(today.getDate() - 14);

    const totalTickets = await prisma.ticket.count({ where: tw });

    const createdLast7 = await prisma.ticket.count({
      where: andTicketScope(user, { createdAt: { gte: sevenDaysAgo } }),
    });
    const createdPrev7 = await prisma.ticket.count({
      where: andTicketScope(user, { createdAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo } }),
    });

    const ticketsByStatus = await prisma.ticket.groupBy({
      by: ["status"],
      where: tw,
      _count: true,
    });

    const ticketsByPriority = await prisma.ticket.groupBy({
      by: ["priority"],
      where: tw,
      _count: true,
    });

    const ticketsToday = await prisma.ticket.count({
      where: andTicketScope(user, { createdAt: { gte: today } }),
    });
    const ticketsYesterday = await prisma.ticket.count({
      where: andTicketScope(user, { createdAt: { gte: yesterday, lt: today } }),
    });

    const resolvedToday = await prisma.ticket.count({
      where: andTicketScope(user, {
        status: "RESOLVED",
        updatedAt: { gte: today },
      }),
    });
    const resolvedYesterday = await prisma.ticket.count({
      where: andTicketScope(user, {
        status: "RESOLVED",
        updatedAt: { gte: yesterday, lt: today },
      }),
    });

    const resolvedTickets = await prisma.ticket.findMany({
      where: andTicketScope(user, {
        status: { in: ["RESOLVED", "CLOSED"] },
      }),
      select: { createdAt: true, updatedAt: true },
    });

    const avgHours = (rows: { createdAt: Date; updatedAt: Date }[]) =>
      rows.length === 0
        ? 0
        : rows.reduce((acc, t) => acc + (t.updatedAt.getTime() - t.createdAt.getTime()) / 3_600_000, 0) / rows.length;

    const avgResolutionTime = avgHours(resolvedTickets);

    const resolvedLast7 = resolvedTickets.filter(
      (t) => t.updatedAt.getTime() >= sevenDaysAgo.getTime()
    );
    const resolvedPrev7 = resolvedTickets.filter(
      (t) => t.updatedAt.getTime() >= fourteenDaysAgo.getTime() && t.updatedAt.getTime() < sevenDaysAgo.getTime()
    );
    const avgLast7 = avgHours(resolvedLast7);
    const avgPrev7 = avgHours(resolvedPrev7);

    const urgentUnassigned = await prisma.ticket.count({
      where: andTicketScope(user, {
        priority: "URGENT",
        status: { notIn: ["RESOLVED", "CLOSED"] },
      }),
    });

    let topAgents;
    if (user.role === "ADMIN") {
      topAgents = await prisma.agentUser.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          _count: {
            select: {
              tickets: {
                where: { status: { notIn: ["CLOSED"] } },
              },
            },
          },
        },
        orderBy: { tickets: { _count: "desc" } },
        take: 5,
      });
    } else {
      const me = await prisma.agentUser.findUnique({
        where: { id: user.id },
        select: {
          id: true,
          name: true,
          email: true,
          _count: {
            select: {
              tickets: { where: { status: { notIn: ["CLOSED"] } } },
            },
          },
        },
      });
      topAgents = me ? [me] : [];
    }

    const last7Days: { date: string; count: number; label: string }[] = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      const nextDate = new Date(date);
      nextDate.setDate(date.getDate() + 1);
      const count = await prisma.ticket.count({
        where: andTicketScope(user, { createdAt: { gte: date, lt: nextDate } }),
      });
      last7Days.push({
        date: date.toISOString().split("T")[0],
        count,
        label: date.toLocaleDateString("es", { weekday: "short", day: "2-digit" }).replace(".", ""),
      });
    }

    const ticketsByLegalType = await prisma.ticket.groupBy({
      by: ["legalType"],
      where: tw,
      _count: true,
      orderBy: { _count: { legalType: "desc" } },
    });

    const caseTypes = await prisma.caseType.findMany({
      select: { legalType: true, slug: true, color: true },
    });
    const legalTypeToSlug = Object.fromEntries(caseTypes.map((c) => [c.legalType || "Sin caso", c.slug]));
    const legalTypeToColor = Object.fromEntries(caseTypes.map((c) => [c.legalType || "Sin caso", c.color]));

    return {
      totalTickets,
      ticketsToday,
      ticketsYesterday,
      resolvedToday,
      resolvedYesterday,
      avgResolutionTime: Math.round(avgResolutionTime * 10) / 10,
      avgLast7: Math.round(avgLast7 * 10) / 10,
      avgPrev7: Math.round(avgPrev7 * 10) / 10,
      urgentUnassigned,
      ticketsByStatus: ticketsByStatus.map((s) => ({ status: s.status, count: s._count })),
      ticketsByPriority: ticketsByPriority.map((p) => ({ priority: p.priority, count: p._count })),
      topAgents: topAgents.map((a) => ({
        id: a.id,
        name: a.name,
        email: a.email,
        activeTickets: a._count.tickets,
      })),
      last7Days,
      ticketsByLegalType: ticketsByLegalType.map((t) => ({
        legalType: t.legalType ?? "Sin caso",
        count: t._count,
        slug: legalTypeToSlug[t.legalType ?? "Sin caso"],
        color: legalTypeToColor[t.legalType ?? "Sin caso"],
      })),
      trends: {
        total: pctTrend(createdLast7, createdPrev7),
        avgTime: pctTrend(Math.round(avgLast7), Math.round(avgPrev7)),
      },
    };
  } catch (error: any) {
    console.error("[Dashboard] Error al cargar stats:", error);
    return null;
  }
}

export default async function DashboardPage() {
  const session = await requireSession();
  const stats = await getDashboardStats(session.user!);
  const displayName =
    session.user!.name ||
    (session.user!.role === "ADMIN"
      ? "Administrador"
      : session.user!.role === "CORRESPONDENT"
        ? "Abogado Corresponsal"
        : "Abogado");

  if (!stats) {
    return (
      <TicketsLayout>
        <div className="mx-auto max-w-7xl">
          <h1 className="text-3xl font-bold text-slate-900">Dashboard</h1>
          <p className="mt-4 text-slate-600">Error al cargar estadísticas.</p>
        </div>
      </TicketsLayout>
    );
  }

  const total = stats.totalTickets;
  const rangeLabel = buildRangeLabel();

  return (
    <TicketsLayout>
      <div className="mx-auto max-w-7xl space-y-5">
        {/* Header con saludo */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-900">
              ¡Hola, {displayName}! <span aria-hidden>👋</span>
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Aquí tienes un resumen general de tu sistema de reclamos.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm">
              <svg className="h-4 w-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M6.75 3v2.25M17.25 3v2.25M3.75 8.25h16.5M4.5 6.75h15A1.5 1.5 0 0 1 21 8.25v11.25A1.5 1.5 0 0 1 19.5 21h-15A1.5 1.5 0 0 1 3 19.5V8.25a1.5 1.5 0 0 1 1.5-1.5Z" />
              </svg>
              <span className="hidden sm:inline">{rangeLabel}</span>
              <span className="sm:hidden">Últimos 7 días</span>
              <svg className="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </div>
            <Link
              href="/tickets"
              className="inline-flex items-center gap-2 rounded-xl bg-[#2196F3] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#1976D2] transition-colors"
            >
              Ver todos los casos
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.25 8.25 21 12m0 0-3.75 3.75M21 12H3" />
              </svg>
            </Link>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Total casos"
            value={stats.totalTickets}
            trend={stats.trends.total}
            trendText="vs. semana anterior"
            color="blue"
            icon="briefcase"
          />
          <KpiCard
            label="Creados hoy"
            value={stats.ticketsToday}
            trend={pctTrend(stats.ticketsToday, stats.ticketsYesterday)}
            trendText="vs. ayer"
            color="sky"
            icon="calendarPlus"
          />
          <KpiCard
            label="Resueltos hoy"
            value={stats.resolvedToday}
            trend={pctTrend(stats.resolvedToday, stats.resolvedYesterday)}
            trendText="vs. ayer"
            color="emerald"
            icon="checkCircle"
          />
          <KpiCard
            label="Tiempo promedio"
            value={`${stats.avgResolutionTime} h`}
            trend={-stats.trends.avgTime}
            trendText="vs. semana anterior"
            color="orange"
            icon="clock"
            invertTrend
          />
        </div>

        {/* Banner urgentes */}
        {stats.urgentUnassigned > 0 && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-red-200 bg-gradient-to-r from-red-50 to-rose-50 p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-100 text-red-600">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
              </span>
              <div>
                <h3 className="text-sm font-bold text-red-800">
                  Atención: {stats.urgentUnassigned} caso(s) urgente(s) activo(s)
                </h3>
                <p className="text-xs text-red-600 mt-0.5">Requieren atención inmediata</p>
              </div>
            </div>
            <Link
              href="/tickets/urgentes"
              className="inline-flex items-center gap-2 rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-600 transition-colors self-start sm:self-auto"
            >
              Ver urgentes
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.25 8.25 21 12m0 0-3.75 3.75M21 12H3" />
              </svg>
            </Link>
          </div>
        )}

        {/* Donuts */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <DistributionCard
            title="Casos por estado"
            href="/tickets"
            total={total}
            items={stats.ticketsByStatus.map((s) => ({
              key: s.status,
              label: statusLabels[s.status as keyof typeof statusLabels],
              value: s.count,
              color: statusColorHex(s.status),
            }))}
          />
          <DistributionCard
            title="Casos por prioridad"
            href="/tickets"
            total={total}
            items={stats.ticketsByPriority.map((p) => ({
              key: p.priority,
              label: priorityLabels[p.priority as keyof typeof priorityLabels],
              value: p.count,
              color: priorityColorHex(p.priority),
            }))}
          />
        </div>

        {/* Últimos 7 días + Top Abogados */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200 shadow-sm lg:col-span-3">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-slate-900">Últimos 7 días</h2>
              <Link href="/tickets" className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 transition">
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
                </svg>
                Ver reporte
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                </svg>
              </Link>
            </div>
            <AreaSparkline data={stats.last7Days.map((d) => ({ label: d.label, value: d.count }))} />
          </div>
          <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200 shadow-sm lg:col-span-2">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-slate-900">Top abogados</h2>
              <Link href="/agentes" className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 transition">
                Ver todos
              </Link>
            </div>
            <div className="space-y-2">
              {stats.topAgents.length === 0 ? (
                <p className="text-sm text-slate-500">No hay abogados con casos asignados.</p>
              ) : (
                stats.topAgents.map((agent) => (
                  <Link
                    key={agent.id}
                    href="/tickets"
                    className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-slate-50 transition"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${avatarColorFor(agent.name)}`}>
                        {initialsOf(agent.name)}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-900 truncate">{agent.name}</div>
                        <div className="text-xs text-slate-500 truncate">{agent.email}</div>
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-600 shrink-0">
                      <span className="text-base leading-none">{agent.activeTickets}</span>
                      <span className="text-[10px] text-blue-500/70">{agent.activeTickets === 1 ? "Caso" : "Casos"}</span>
                    </span>
                  </Link>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Casos por tipo */}
        <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-slate-900">Casos por tipo</h2>
            <Link href="/casos" className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 transition">
              Ver todos
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
            {stats.ticketsByLegalType.length === 0 ? (
              <p className="text-sm text-slate-500">No hay datos disponibles.</p>
            ) : (
              stats.ticketsByLegalType.map((item, index) => {
                const href = item.slug ? `/tickets/tipo/${item.slug}` : "/tickets";
                const pct = total > 0 ? Math.round((item.count / total) * 1000) / 10 : 0;
                const accent = typeAccent(item.legalType);
                return (
                  <Link
                    key={`${item.legalType}-${index}`}
                    href={href}
                    className={`flex flex-col gap-2 rounded-xl p-3 ring-1 transition hover:shadow-md ${accent.bg} ${accent.ring}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${accent.badge}`}>
                        {index + 1}
                      </span>
                      <span className={accent.icon}>
                        <TypeIcon legalType={item.legalType} />
                      </span>
                    </div>
                    <div className="text-sm font-semibold text-slate-800 leading-tight truncate" title={item.legalType}>
                      {item.legalType}
                    </div>
                    <div className="flex items-baseline justify-between">
                      <span className="text-xl font-bold text-slate-900">{item.count}</span>
                      <span className="text-[11px] font-medium text-slate-500">{pct}%</span>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      </div>
    </TicketsLayout>
  );
}

// ─── Subcomponentes ───────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  trend,
  trendText,
  color,
  icon,
  invertTrend = false,
}: {
  label: string;
  value: number | string;
  trend: number;
  trendText: string;
  color: "blue" | "sky" | "emerald" | "orange";
  icon: "briefcase" | "calendarPlus" | "checkCircle" | "clock";
  invertTrend?: boolean;
}) {
  const palette: Record<string, { iconBg: string; iconText: string }> = {
    blue: { iconBg: "bg-blue-100", iconText: "text-blue-600" },
    sky: { iconBg: "bg-sky-100", iconText: "text-sky-600" },
    emerald: { iconBg: "bg-emerald-100", iconText: "text-emerald-600" },
    orange: { iconBg: "bg-orange-100", iconText: "text-orange-600" },
  };
  const a = palette[color];
  const positive = invertTrend ? trend > 0 : trend > 0;
  const negative = invertTrend ? trend < 0 : trend < 0;
  const trendColor = trend === 0 ? "text-slate-400" : positive ? "text-emerald-600" : negative ? "text-rose-500" : "text-slate-400";
  const trendIcon = trend === 0 ? "–" : trend > 0 ? "↑" : "↓";

  return (
    <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200 shadow-sm hover:shadow-md transition">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
          <p className="mt-1.5 text-3xl font-bold text-slate-900 leading-none">{value}</p>
        </div>
        <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${a.iconBg} ${a.iconText}`}>
          <KpiIcon name={icon} />
        </span>
      </div>
      <div className="mt-3 flex items-center gap-1 text-xs">
        {trend === 0 ? (
          <span className="text-slate-400 inline-flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
            Sin cambios
          </span>
        ) : (
          <>
            <span className={`${trendColor} font-semibold inline-flex items-center gap-0.5`}>
              {trendIcon} {Math.abs(trend)}%
            </span>
            <span className="text-slate-400">{trendText}</span>
          </>
        )}
      </div>
    </div>
  );
}

function KpiIcon({ name }: { name: "briefcase" | "calendarPlus" | "checkCircle" | "clock" }) {
  if (name === "briefcase") {
    return (
      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20.25 14.15v4.25c0 1.094-.787 2.036-1.872 2.18-2.087.277-4.216.42-6.378.42s-4.291-.143-6.378-.42c-1.085-.144-1.872-1.086-1.872-2.18v-4.25m16.5 0a2.18 2.18 0 0 0 .75-1.661V8.706c0-1.081-.768-2.015-1.837-2.175a48.114 48.114 0 0 0-3.413-.387m4.5 8.006c-.194.165-.42.295-.673.38A23.978 23.978 0 0 1 12 15.75c-2.648 0-5.195-.429-7.577-1.22a2.016 2.016 0 0 1-.673-.38m0 0A2.18 2.18 0 0 1 3 12.489V8.706c0-1.081.768-2.015 1.837-2.175a48.111 48.111 0 0 1 3.413-.387m7.5 0V5.25A2.25 2.25 0 0 0 13.5 3h-3a2.25 2.25 0 0 0-2.25 2.25v.894m7.5 0a48.667 48.667 0 0 0-7.5 0M12 12.75h.008v.008H12v-.008Z" />
      </svg>
    );
  }
  if (name === "calendarPlus") {
    return (
      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 10.5v6m3-3H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      </svg>
    );
  }
  if (name === "checkCircle") {
    return (
      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      </svg>
    );
  }
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  );
}

function DistributionCard({
  title,
  href,
  total,
  items,
}: {
  title: string;
  href: string;
  total: number;
  items: { key: string; label: string; value: number; color: string }[];
}) {
  const sortedItems = [...items].sort((a, b) => b.value - a.value);
  const segments: DonutSegment[] = sortedItems.map((s) => ({ label: s.label, value: s.value, color: s.color }));
  return (
    <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <Link href={href} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 transition">
          Ver detalle →
        </Link>
      </div>
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
        <DonutChart segments={segments} centerValue={total} centerLabel="Total" />
        <ul className="flex-1 w-full space-y-1.5">
          {sortedItems.map((s) => {
            const pct = total > 0 ? Math.round((s.value / total) * 1000) / 10 : 0;
            return (
              <li key={s.key} className="flex items-center justify-between text-sm">
                <span className="inline-flex items-center gap-2 min-w-0">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                  <span className="text-slate-700 truncate">{s.label}</span>
                </span>
                <span className="inline-flex items-center gap-3 shrink-0 ml-3">
                  <span className="font-semibold text-slate-900 tabular-nums">{s.value}</span>
                  <span className="text-xs text-slate-400 tabular-nums w-12 text-right">{pct}%</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function TypeIcon({ legalType }: { legalType: string }) {
  const t = (legalType || "").toLowerCase();
  if (t.includes("tránsito") || t.includes("transito")) {
    return (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8.25 18.75a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0H15m0 0a1.5 1.5 0 0 0 3 0m-3 0a1.5 1.5 0 0 1 3 0m0 0h1.5a.75.75 0 0 0 .75-.75V12l-2.25-3H17.5l-1-3H4.5a1.5 1.5 0 0 0-1.5 1.5v11.25c0 .414.336.75.75.75h.75M9 9h6" />
      </svg>
    );
  }
  if (t.includes("trabajo")) {
    return (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20.25 14.15v4.25c0 1.094-.787 2.036-1.872 2.18a47.736 47.736 0 0 1-12.756 0c-1.085-.144-1.872-1.086-1.872-2.18v-4.25M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
      </svg>
    );
  }
  if (t.includes("salud") || t.includes("amparo")) {
    return (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
      </svg>
    );
  }
  if (t.includes("comercial")) {
    return (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 0 0-16.536-1.84M7.5 14.25 5.106 5.272M6 20.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm12.75 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" />
      </svg>
    );
  }
  if (t.includes("sucesi")) {
    return (
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
      </svg>
    );
  }
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m5.85 8.85L19.5 17.25M19.5 9.75v2.625m-7.5 4.875h.008v.008h-.008v-.008Z" />
    </svg>
  );
}

// ─── Helpers de color ─────────────────────────────────────────────────────────

function statusColorHex(status: string): string {
  switch (status) {
    case "OPEN":
      return "#38BDF8"; // sky-400
    case "IN_PROGRESS":
      return "#F59E0B"; // amber-500
    case "WAITING_CUSTOMER":
      return "#1D4ED8"; // blue-700
    case "RESOLVED":
      return "#10B981"; // emerald-500
    case "CLOSED":
      return "#64748B"; // slate-500
    default:
      return "#CBD5E1";
  }
}

function priorityColorHex(priority: string): string {
  switch (priority) {
    case "URGENT":
      return "#EF4444"; // red-500
    case "HIGH":
      return "#F59E0B"; // amber-500
    case "NORMAL":
      return "#2563EB"; // blue-600
    case "LOW":
      return "#94A3B8"; // slate-400
    default:
      return "#CBD5E1";
  }
}

function typeAccent(legalType: string): { bg: string; ring: string; badge: string; icon: string } {
  const t = (legalType || "").toLowerCase();
  if (t === "sin caso") return tintAccent("blue");
  if (t.includes("trabajo")) return tintAccent("emerald");
  if (t.includes("tránsito") || t.includes("transito") || t.includes("accidente")) return tintAccent("orange");
  if (t.includes("comercial")) return tintAccent("rose");
  if (t.includes("salud") || t.includes("amparo")) return tintAccent("cyan");
  if (t.includes("sucesi")) return tintAccent("violet");
  return tintAccent("slate");
}

function tintAccent(color: "blue" | "emerald" | "orange" | "rose" | "cyan" | "violet" | "slate" | "amber") {
  const map = {
    blue: { bg: "bg-blue-50", ring: "ring-blue-100", badge: "bg-blue-100 text-blue-700", icon: "text-blue-500" },
    emerald: { bg: "bg-emerald-50", ring: "ring-emerald-100", badge: "bg-emerald-100 text-emerald-700", icon: "text-emerald-500" },
    orange: { bg: "bg-orange-50", ring: "ring-orange-100", badge: "bg-orange-100 text-orange-700", icon: "text-orange-500" },
    rose: { bg: "bg-rose-50", ring: "ring-rose-100", badge: "bg-rose-100 text-rose-700", icon: "text-rose-500" },
    cyan: { bg: "bg-cyan-50", ring: "ring-cyan-100", badge: "bg-cyan-100 text-cyan-700", icon: "text-cyan-500" },
    violet: { bg: "bg-violet-50", ring: "ring-violet-100", badge: "bg-violet-100 text-violet-700", icon: "text-violet-500" },
    slate: { bg: "bg-slate-50", ring: "ring-slate-100", badge: "bg-slate-200 text-slate-700", icon: "text-slate-500" },
    amber: { bg: "bg-amber-50", ring: "ring-amber-100", badge: "bg-amber-100 text-amber-700", icon: "text-amber-500" },
  };
  return map[color];
}

function initialsOf(name: string | null | undefined): string {
  if (!name) return "??";
  const clean = name.trim();
  if (!clean) return "??";
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function avatarColorFor(name: string | null | undefined): string {
  const palette = [
    "bg-blue-100 text-blue-700",
    "bg-amber-100 text-amber-700",
    "bg-emerald-100 text-emerald-700",
    "bg-violet-100 text-violet-700",
    "bg-rose-100 text-rose-700",
    "bg-teal-100 text-teal-700",
    "bg-orange-100 text-orange-700",
    "bg-cyan-100 text-cyan-700",
  ];
  const seed = (name || "?").split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return palette[seed % palette.length];
}

function buildRangeLabel(): string {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 6);
  const opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric" };
  return `${start.toLocaleDateString("es-AR", opts).replace(".", "")} – ${end.toLocaleDateString("es-AR", opts).replace(".", "")}`;
}

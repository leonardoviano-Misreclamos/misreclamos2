import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { prisma } from "@/lib/db";
import { sessionOptions, type SessionData } from "@/lib/auth";
import { ticketAccessibleByUser } from "@/lib/ticket-scope";

const CASEOPS_INTAKE_URL =
  process.env.CASEOPS_INTAKE_URL ||
  "https://TU-BACKEND-CASEOPS.easypanel.host/intake/webhook";
const CASEOPS_INTAKE_SECRET =
  process.env.CASEOPS_INTAKE_SECRET ||
  "Plnoajhe3hyT2C1yeasKPryaGaYmbUxO";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const canAccess = await ticketAccessibleByUser(session.user, id);
  if (!canAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ticket = await prisma.ticket.findUnique({
    where: { id },
    include: { customer: true },
  });

  if (!ticket) {
    return NextResponse.json({ error: "Ticket no encontrado" }, { status: 404 });
  }

  if (ticket.status === "RESOLVED" || ticket.status === "CLOSED") {
    return NextResponse.json(
      { error: "No se puede aceptar un caso resuelto o cerrado" },
      { status: 400 }
    );
  }

  const previousAcceptEvents = await prisma.ticketEvent.findMany({
    where: {
      ticketId: ticket.id,
      type: "STATUS_CHANGED",
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const alreadyAccepted = previousAcceptEvents.some((event) => {
    const payload = event.payload as Record<string, unknown> | null;
    return payload?.action === "CASE_ACCEPTED";
  });

  if (alreadyAccepted) {
    return NextResponse.json({
      ok: true,
      alreadyProcessed: true,
      message: "El caso ya habia sido aceptado y enviado.",
    });
  }

  const body = {
    ticketCode: ticket.code,
    legalType: ticket.legalType,
    category: ticket.category,
    priority: ticket.priority,
    channel: ticket.channel,
    summary: ticket.aiSummary,
    customer: {
      name: ticket.customer?.name,
      phone: ticket.customer?.phone,
      email: ticket.customer?.email,
    },
  };

  let intakeResponseText = "";
  let intakeStatus = 0;
  try {
    const intakeResponse = await fetch(CASEOPS_INTAKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-intake-secret": CASEOPS_INTAKE_SECRET,
      },
      body: JSON.stringify(body),
    });
    intakeStatus = intakeResponse.status;
    intakeResponseText = await intakeResponse.text();

    if (!intakeResponse.ok) {
      return NextResponse.json(
        {
          error: "No se pudo enviar el caso a la plataforma externa",
          details: intakeResponseText || `HTTP ${intakeResponse.status}`,
          intakeHttpStatus: intakeResponse.status,
        },
        { status: 502 }
      );
    }
  } catch (error: any) {
    return NextResponse.json(
      {
        error: "Error de red al enviar el caso a la plataforma externa",
        details: error?.message || "Unknown error",
      },
      { status: 502 }
    );
  }

  const previousStatus = ticket.status;
  await prisma.ticket.update({
    where: { id: ticket.id },
    data: { status: "IN_PROGRESS", lastMessageAt: new Date() },
  });

  await prisma.ticketEvent.create({
    data: {
      ticketId: ticket.id,
      type: "STATUS_CHANGED",
      payload: {
        action: "CASE_ACCEPTED",
        fromStatus: previousStatus,
        toStatus: "IN_PROGRESS",
        intakeUrl: CASEOPS_INTAKE_URL,
        intakeStatus,
        intakeResponse: intakeResponseText.slice(0, 1200),
        acceptedBy: session.user.id,
        acceptedByRole: session.user.role,
      },
    },
  });

  return NextResponse.json({
    ok: true,
    status: "IN_PROGRESS",
    forwarded: true,
  });
}

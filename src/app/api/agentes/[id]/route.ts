import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isAdmin, sessionOptions, type SessionData } from "@/lib/auth";

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: z.enum(["ADMIN", "SUPPORT", "CORRESPONDENT"]).optional(),
});

// DELETE /api/agentes/[id] - Eliminar agente
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.user || !isAdmin(session.user)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  const { id } = await params;

  // Verificar si tiene tickets asignados
  const agente = await prisma.agentUser.findUnique({
    where: { id },
    include: {
      _count: {
        select: { tickets: true },
      },
    },
  });

  if (!agente) {
    return NextResponse.json({ error: "Agente no encontrado" }, { status: 404 });
  }

  // Si tiene tickets asignados, desasignarlos primero
  if (agente._count.tickets > 0) {
    await prisma.ticket.updateMany({
      where: { assignedToUserId: id },
      data: { assignedToUserId: null },
    });
    console.log(`[Agentes] Desasignados ${agente._count.tickets} tickets del agente ${agente.name}`);
  }

  await prisma.agentUser.delete({
    where: { id },
  });

  console.log(`[Agentes] ✅ Agente eliminado: ${agente.name}`);

  return NextResponse.json({ ok: true });
}

// PATCH /api/agentes/[id] - Actualizar agente
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.user || !isAdmin(session.user)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  const { id } = await params;
  const json = await req.json().catch(() => null);
  const parsed = updateAgentSchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json({ 
      error: "Formato inválido", 
      details: parsed.error.flatten() 
    }, { status: 400 });
  }

  const agente = await prisma.agentUser.update({
    where: { id },
    data: parsed.data,
  });

  console.log(`[Agentes] ✅ Agente actualizado: ${agente.name}`);

  return NextResponse.json({ agente });
}

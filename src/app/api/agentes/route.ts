import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isAdmin, sessionOptions, type SessionData } from "@/lib/auth";
import { hashPassword, normalizeUsername } from "@/lib/password";

const createAgentSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(10, "El teléfono debe tener al menos 10 dígitos"),
  username: z.string().min(2).max(64),
  password: z.string().min(8).max(128),
  role: z.enum(["ADMIN", "SUPPORT"]).default("SUPPORT"),
});

// GET /api/agentes - Listar todos los agentes
export async function GET() {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.user || !isAdmin(session.user)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  const agentes = await prisma.agentUser.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: { tickets: true },
      },
    },
  });

  return NextResponse.json({ agentes });
}

// POST /api/agentes - Crear nuevo agente
export async function POST(req: Request) {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.user || !isAdmin(session.user)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  const json = await req.json().catch(() => null);
  const parsed = createAgentSchema.safeParse(json);
  
  if (!parsed.success) {
    return NextResponse.json({ 
      error: "Formato inválido", 
      details: parsed.error.flatten() 
    }, { status: 400 });
  }

  const { name, email, phone, role, username, password } = parsed.data;
  const normalizedUsername = normalizeUsername(username);

  // Verificar si ya existe
  const existing = await prisma.agentUser.findUnique({
    where: { email },
  });

  if (existing) {
    return NextResponse.json({ 
      error: "Ya existe un agente con ese email" 
    }, { status: 400 });
  }

  const existingUsername = await prisma.agentUser.findFirst({
    where: { username: normalizedUsername },
    select: { id: true },
  });

  if (existingUsername) {
    return NextResponse.json(
      { error: "Ese nombre de usuario ya está en uso" },
      { status: 400 }
    );
  }

  const passwordHash = await hashPassword(password);

  const agente = await prisma.agentUser.create({
    data: {
      name,
      email,
      phone,
      role,
      username: normalizedUsername,
      passwordHash,
    },
  });

  console.log(`[Agentes] ✅ Agente creado con acceso: ${name} (${email}, ${phone})`);

  return NextResponse.json({ agente }, { status: 201 });
}

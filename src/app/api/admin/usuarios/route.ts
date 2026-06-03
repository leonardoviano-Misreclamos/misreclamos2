import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isAdmin, sessionOptions, type SessionData } from "@/lib/auth";
import { hashPassword, normalizeUsername } from "@/lib/password";

const createSchema = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(8).max(128),
  agentId: z.string().optional(),
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(6).optional(),
  role: z.enum(["ADMIN", "SUPPORT", "CORRESPONDENT"]).optional(),
});

/** GET: lista abogados + estado de login */
export async function GET() {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.user || !isAdmin(session.user)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  const agentes = await prisma.agentUser.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      username: true,
      passwordHash: true,
      matricula: true,
    },
  });

  return NextResponse.json({
    agentes: agentes.map((a) => ({
      ...a,
      hasPassword: !!a.passwordHash,
      passwordHash: undefined,
    })),
  });
}

/** POST: asignar usuario/contraseña a un abogado existente o crear abogado nuevo */
export async function POST(req: Request) {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.user || !isAdmin(session.user)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 403 });
  }

  const json = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", details: parsed.error.flatten() }, { status: 400 });
  }

  const { username, password, agentId, name, email, phone, role } = parsed.data;
  const u = normalizeUsername(username);

  const existingUser = await prisma.agentUser.findFirst({ where: { username: u } });
  if (existingUser) {
    return NextResponse.json({ error: "Ese nombre de usuario ya existe" }, { status: 400 });
  }

  const pwdHash = await hashPassword(password);

  if (agentId) {
    const updated = await prisma.agentUser.update({
      where: { id: agentId },
      data: { username: u, passwordHash: pwdHash },
      select: { id: true, name: true, email: true, username: true, role: true },
    });
    return NextResponse.json({ ok: true, agent: updated });
  }

  if (!name || !email || !phone) {
    return NextResponse.json(
      { error: "Para crear un abogado nuevo indicá nombre, email y teléfono" },
      { status: 400 }
    );
  }

  const created = await prisma.agentUser.create({
    data: {
      name,
      email,
      phone,
      role: role ?? "SUPPORT",
      username: u,
      passwordHash: pwdHash,
    },
    select: { id: true, name: true, email: true, username: true, role: true },
  });

  return NextResponse.json({ ok: true, agent: created });
}

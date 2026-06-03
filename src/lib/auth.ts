import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export type SessionUser = {
  id: string;
  email?: string;
  name?: string;
  role: "ADMIN" | "SUPPORT" | "CORRESPONDENT";
  /** Sesión legacy (APP_PASSWORD + usuario admin) sin fila en AgentUser */
  legacy?: boolean;
};

export function isAdmin(user: SessionUser | undefined): boolean {
  return user?.role === "ADMIN";
}

export type SessionData = {
  user?: SessionUser;
};

const fallbackPassword = "change-this-session-password-in-env-please";

export const sessionOptions: SessionOptions = {
  cookieName: "misreclamos_session",
  password: process.env.SESSION_PASSWORD || fallbackPassword,
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
  },
};

export async function getSession() {
  try {
    return getIronSession<SessionData>(await cookies(), sessionOptions);
  } catch (error) {
    console.error("Error al obtener sesión:", error);
    // Retornar sesión vacía si hay error
    return { user: undefined } as SessionData;
  }
}

export async function requireSession() {
  const session = await getSession();
  if (!session.user) {
    redirect("/login");
  }
  return session;
}

/** Solo administradores; abogados van a /tickets */
export async function requireAdmin() {
  const session = await requireSession();
  if (!isAdmin(session.user!)) {
    redirect("/tickets");
  }
  return session;
}

export function ensureAppPasswordConfigured() {
  if (!process.env.APP_PASSWORD) {
    throw new Error("APP_PASSWORD no está configurada en el entorno");
  }
}

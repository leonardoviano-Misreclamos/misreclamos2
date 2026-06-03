"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import { CaseTypesNavLinks } from "@/components/casos/CaseTypesNavLinks";
import { SidebarIcons, type SidebarIconName } from "@/components/tickets/SidebarIcons";

const NAV_ACTIVE_BG = "#375A7F";

/** URL de la app externa “Gestión y análisis”. Si está vacía, el ítem no se muestra. */
const GESTION_ANALISIS_URL = process.env.NEXT_PUBLIC_GESTION_ANALISIS_URL?.trim() || "";

export function TicketsLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[#f3f8fd]">
      {/* Overlay backdrop - solo mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <ReclamosSidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <main className="min-h-screen p-4 sm:p-6 lg:p-8 bg-slate-50 md:rounded-l-2xl shadow-sm md:ml-[17rem]">
        {/* Botón hamburguesa - solo mobile */}
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className="mb-4 flex items-center gap-2 rounded-lg bg-[#2C3E50] px-3 py-2 text-white shadow-sm md:hidden"
          aria-label="Abrir menú"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          <span className="text-sm font-medium">Menú</span>
        </button>
        {children}
      </main>
    </div>
  );
}

function ReclamosSidebar({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const [role, setRole] = useState<"ADMIN" | "SUPPORT" | "CORRESPONDENT" | null>(null);
  const [displayName, setDisplayName] = useState<string>("");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.user?.role) setRole(d.user.role);
        if (d.user?.name) setDisplayName(d.user.name);
      })
      .catch(() => setRole("SUPPORT"));
  }, []);

  const isAdmin = role === "ADMIN";
  const navReady = role !== null;

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  };

  return (
    <aside
      className={`fixed left-0 top-0 bottom-0 z-40 flex flex-col shadow-lg w-[17rem] flex-shrink-0 transition-transform duration-300 ease-in-out ${
        isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
      }`}
    >
      {/* Barra superior: logo + nombre - fondo oscuro */}
      <div className="bg-[#2C3E50] px-4 py-5 flex-shrink-0 relative">
        {/* Botón cerrar - solo mobile */}
        <button
          onClick={onClose}
          className="absolute right-3 top-3 flex items-center justify-center rounded-lg p-1.5 text-white/60 hover:text-white hover:bg-white/10 transition md:hidden"
          aria-label="Cerrar menú"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <Link href="/tickets" className="flex flex-col items-center gap-2 hover:opacity-95 transition" onClick={onClose}>
          <img
            src="/Logo-MisReclamos.png"
            alt="Mis Reclamos"
            className="h-14 w-auto max-w-[160px] object-contain logo-img min-h-[40px]"
            onError={(e) => {
              const el = e.target as HTMLImageElement;
              el.style.display = "none";
              el.nextElementSibling?.classList.remove("hidden");
            }}
          />
          <div className="hidden logo-fallback flex items-center justify-center gap-2">
            <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-white/10 text-white text-xl font-bold">
              ⚖
            </span>
          </div>
          <span className="text-base font-bold text-white tracking-tight">Mis Reclamos</span>
        </Link>
      </div>

      {/* Navegación: iconos + texto + chevron, ítem activo #375A7F */}
      <nav className="flex-1 min-h-0 space-y-0 px-3 py-4 text-sm overflow-y-auto overflow-x-hidden bg-[#2C3E50]">
        <SectionTitle>Inicio</SectionTitle>
        <NavLink label="Dashboard" href="/dashboard" icon="home" onNavigate={onClose} />
        <NavLink label="Todos los Casos" href="/tickets" icon="folder" onNavigate={onClose} />
        {navReady && isAdmin ? (
          <NavLink label="Legado" href="/legado" icon="briefcase" onNavigate={onClose} />
        ) : null}
        {navReady && GESTION_ANALISIS_URL ? (
          <ExternalNavLink
            label="Gestión y análisis"
            href={GESTION_ANALISIS_URL}
            icon="chartBar"
            onNavigate={onClose}
          />
        ) : null}

        <div className="my-2 border-t border-white/10" />

        <SectionTitle>Por Estado</SectionTitle>
        <NavLink label="Abiertos" href="/tickets/abiertos" icon="check" iconColor="emerald" onNavigate={onClose} />
        <NavLink label="En Progreso" href="/tickets/en-progreso" icon="clock" iconColor="orange" onNavigate={onClose} />
        <NavLink label="Esperando Cliente" href="/tickets/esperando-cliente" icon="chat" iconColor="sky" onNavigate={onClose} />
        <NavLink label="Resueltos" href="/tickets/resueltos" icon="check" iconColor="emerald" onNavigate={onClose} />
        <NavLink label="Cerrados" href="/tickets/cerrados" icon="folder" onNavigate={onClose} />

        <div className="my-2 border-t border-white/10" />

        <SectionTitle>Por tipo de caso</SectionTitle>
        <CaseTypesNavLinks onNavigate={onClose} />

        <div className="my-2 border-t border-white/10" />

        {navReady && isAdmin ? (
          <>
            <SectionTitle>Gestión</SectionTitle>
            <NavLink label="Casos" href="/casos" icon="folder" onNavigate={onClose} />
            <NavLink label="Abogados" href="/agentes" icon="users" onNavigate={onClose} />
            <NavLink label="Clientes" href="/clientes" icon="users" onNavigate={onClose} />
            <NavLink label="Configuración" href="/configuracion" icon="settings" onNavigate={onClose} />
            <NavLink label="Usuarios acceso" href="/configuracion/usuarios" icon="users" onNavigate={onClose} />
          </>
        ) : null}
      </nav>

      {/* Pie */}
      <div className="bg-[#2C3E50] px-4 py-4 flex-shrink-0 border-t border-white/10 space-y-2">
        {displayName ? (
          <p className="text-center text-xs text-white/70 truncate px-1" title={displayName}>
            {displayName}
            {role ? (
              <span className="block text-[10px] text-white/50 mt-0.5">
                {role === "ADMIN"
                  ? "Administrador"
                  : role === "CORRESPONDENT"
                    ? "Abogado Corresponsal"
                    : "Abogado"}
              </span>
            ) : null}
          </p>
        ) : null}
        <button
          onClick={handleLogout}
          className="w-full flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium text-white hover:bg-white/10 transition-colors"
        >
          Cerrar sesión
        </button>
      </div>
    </aside>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1.5 pt-4 text-[11px] font-bold uppercase tracking-widest text-[#7A8E9F]">
      {children}
    </div>
  );
}

function ExternalNavLink({
  href,
  label,
  icon,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: Exclude<SidebarIconName, "chevronRight" | "externalLink">;
  onNavigate?: () => void;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onNavigate}
      className="group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white/95 transition-all duration-200 ease-out hover:bg-white/10"
    >
      <span className="flex-shrink-0 text-white/90 group-hover:text-white">
        <SidebarIcons name={icon} className="h-5 w-5" />
      </span>
      <span className="flex-1 min-w-0 break-words group-hover:text-white">{label}</span>
      <span className="flex-shrink-0 text-white/50 group-hover:text-white/70" title="Se abre en otra pestaña">
        <SidebarIcons name="externalLink" className="h-4 w-4" />
      </span>
    </a>
  );
}

function NavLink({
  href,
  label,
  icon,
  iconColor,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: Exclude<SidebarIconName, "chevronRight" | "externalLink">;
  iconColor?: "emerald" | "orange" | "sky";
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/tickets" && pathname.startsWith(href));

  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 ease-out ${!active ? "hover:bg-white/10" : ""}`}
      style={active ? { backgroundColor: NAV_ACTIVE_BG } : undefined}
    >
      <span
        className={`flex-shrink-0 ${active ? "text-white" : "text-white/90 group-hover:text-white"}`}
        style={iconColor && !active ? iconColorStyle(iconColor) : undefined}
      >
        <SidebarIcons name={icon} className="h-5 w-5" />
      </span>
      <span className="flex-1 min-w-0 break-words text-white/95 group-hover:text-white">
        {label}
      </span>
      <span className={`flex-shrink-0 text-sm ${active ? "text-white" : "text-white/50"}`}>
        <SidebarIcons name="chevronRight" className="h-4 w-4" />
      </span>
    </Link>
  );
}

function iconColorStyle(color: "emerald" | "orange" | "sky"): React.CSSProperties {
  const map = { emerald: "#34D399", orange: "#F97316", sky: "#38BDF8" };
  return { color: map[color] };
}

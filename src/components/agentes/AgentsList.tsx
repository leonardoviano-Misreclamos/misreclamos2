"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Agent {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  createdAt: Date;
  _count: {
    tickets: number;
  };
}

export function AgentsList({ agentes }: { agentes: Agent[] }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`¿Seguro que querés eliminar a ${name}?`)) return;

    setDeleting(id);
    try {
      const res = await fetch(`/api/agentes/${id}`, {
        method: "DELETE",
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Error al eliminar");
        return;
      }

      router.refresh();
    } catch (error) {
      alert("Error de red");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
      <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-800">Equipo de Abogados</h2>
      </div>
      <div className="divide-y divide-slate-100">
        {agentes.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            No hay agentes registrados aún.
          </div>
        ) : (
          agentes.map((agente) => (
            <div key={agente.id} className="flex items-center justify-between px-4 py-4 hover:bg-slate-50">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">{agente.name}</span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                      agente.role === "ADMIN"
                        ? "bg-purple-100 text-purple-800"
                        : "bg-blue-100 text-blue-800"
                    }`}
                  >
                    {agente.role === "ADMIN"
                      ? "Admin"
                      : agente.role === "CORRESPONDENT"
                        ? "Abogado Corresponsal"
                        : "Abogado"}
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-500">{agente.email}</div>
                <div className="mt-1 text-xs text-slate-500">📱 {agente.phone}</div>
                <div className="mt-1 text-xs text-slate-400">
                  {agente._count.tickets} {agente._count.tickets === 1 ? "ticket asignado" : "tickets asignados"}
                </div>
              </div>
              <button
                onClick={() => handleDelete(agente.id, agente.name)}
                disabled={deleting === agente.id}
                className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                title={agente._count.tickets > 0 ? `Eliminar agente (se desasignarán ${agente._count.tickets} tickets)` : "Eliminar agente"}
              >
                {deleting === agente.id ? "Eliminando..." : "Eliminar"}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

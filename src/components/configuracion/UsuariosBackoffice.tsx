"use client";

import { useCallback, useEffect, useState } from "react";

type AgentRow = {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  username: string | null;
  hasPassword: boolean;
  matricula: string | null;
};

export default function UsuariosBackoffice() {
  const [agentes, setAgentes] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [agentId, setAgentId] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newRole, setNewRole] = useState<"ADMIN" | "SUPPORT" | "CORRESPONDENT">("SUPPORT");
  const [mode, setMode] = useState<"existing" | "new">("existing");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/usuarios");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error");
      setAgentes(data.agentes || []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (mode === "existing") {
        if (!agentId || !username.trim() || password.length < 8) {
          setError("Elegí un abogado, usuario y contraseña (mín. 8 caracteres).");
          setSaving(false);
          return;
        }
        const res = await fetch("/api/admin/usuarios", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId, username, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Error");
      } else {
        if (!newName.trim() || !newEmail.trim() || !newPhone.trim() || !username.trim() || password.length < 8) {
          setError("Completá todos los campos. Contraseña mín. 8 caracteres.");
          setSaving(false);
          return;
        }
        const res = await fetch("/api/admin/usuarios", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username,
            password,
            name: newName,
            email: newEmail,
            phone: newPhone,
            role: newRole,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Error");
      }
      setPassword("");
      setUsername("");
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-sm text-slate-500">Cargando…</p>;
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Usuarios del backoffice</h2>
        <p className="mt-1 text-sm text-slate-600">
          Cada abogado inicia sesión con su usuario y contraseña. Solo ven los casos que les asignen (perfil abogado).
          Los administradores ven todo el sistema.
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-600">
            <tr>
              <th className="px-4 py-3">Nombre</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Rol</th>
              <th className="px-4 py-3">Usuario login</th>
              <th className="px-4 py-3">Acceso</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {agentes.map((a) => (
              <tr key={a.id} className="hover:bg-slate-50/80">
                <td className="px-4 py-3 font-medium text-slate-900">{a.name}</td>
                <td className="px-4 py-3 text-slate-600">{a.email}</td>
                <td className="px-4 py-3">
                  {a.role === "ADMIN"
                    ? "Administrador"
                    : a.role === "CORRESPONDENT"
                      ? "Abogado Corresponsal"
                      : "Abogado"}
                </td>
                <td className="px-4 py-3 text-slate-600">{a.username || "—"}</td>
                <td className="px-4 py-3">
                  {a.hasPassword ? (
                    <span className="text-emerald-700">Activo</span>
                  ) : (
                    <span className="text-amber-700">Sin contraseña</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={submit} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setMode("existing")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${mode === "existing" ? "bg-[#2196F3] text-white" : "bg-slate-100 text-slate-700"}`}
          >
            Activar abogado existente
          </button>
          <button
            type="button"
            onClick={() => setMode("new")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${mode === "new" ? "bg-[#2196F3] text-white" : "bg-slate-100 text-slate-700"}`}
          >
            Nuevo abogado + acceso
          </button>
        </div>

        {mode === "existing" ? (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Abogado</label>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="w-full max-w-md rounded-lg border border-slate-200 px-3 py-2 text-sm"
              required
            >
              <option value="">Seleccionar…</option>
              {agentes.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.email})
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 max-w-2xl">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Nombre completo</label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Teléfono (WhatsApp)</label>
              <input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Rol en el sistema</label>
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as "ADMIN" | "SUPPORT" | "CORRESPONDENT")}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              >
                <option value="SUPPORT">Abogado (solo casos asignados)</option>
                <option value="CORRESPONDENT">Abogado Corresponsal (solo casos asignados)</option>
                <option value="ADMIN">Administrador</option>
              </select>
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 max-w-xl">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Usuario (login)</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              placeholder="ej: maria.garcia"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Contraseña</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              placeholder="Mínimo 8 caracteres"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-[#2196F3] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#1976D2] disabled:opacity-60"
        >
          {saving ? "Guardando…" : "Guardar acceso"}
        </button>
      </form>
    </div>
  );
}

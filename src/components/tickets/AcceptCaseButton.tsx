"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TicketStatus } from "@/lib/types";

type Props = {
  ticketId: string;
  currentStatus: TicketStatus;
};

export function AcceptCaseButton({ ticketId, currentStatus }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isBlocked = currentStatus === "RESOLVED" || currentStatus === "CLOSED";
  const label = isBlocked ? "Caso finalizado" : "Aceptar y procesar caso";

  const onAccept = () => {
    setMessage(null);
    setError(null);

    startTransition(async () => {
      try {
        const res = await fetch(`/api/tickets/${ticketId}/accept`, {
          method: "POST",
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const base = data?.error || "No se pudo aceptar el caso";
          const httpExt =
            typeof data?.intakeHttpStatus === "number"
              ? ` [externo HTTP ${data.intakeHttpStatus}]`
              : "";
          const detail =
            typeof data?.details === "string" && data.details.trim()
              ? data.details.trim().slice(0, 500)
              : null;
          setError(
            detail ? `${base}${httpExt} — ${detail}` : `${base}${httpExt}`
          );
          return;
        }

        if (data?.alreadyProcessed) {
          setMessage("Este caso ya habia sido aceptado y enviado.");
        } else {
          setMessage("Caso aceptado y enviado a la siguiente plataforma.");
        }

        router.refresh();
      } catch {
        setError("Error de red al aceptar el caso");
      }
    });
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={onAccept}
        disabled={isPending || isBlocked}
        className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {isPending ? "Procesando..." : label}
      </button>
      {message ? <p className="text-xs text-emerald-700">{message}</p> : null}
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

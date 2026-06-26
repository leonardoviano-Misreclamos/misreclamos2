import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { sendWhatsAppMessage } from "@/lib/builderbot";
import { generateTicketCode } from "@/lib/tickets";
import { uploadToBlob, getFileExtension } from "@/lib/blob";
import { summarizeConversation, classifyLegalType, transcribeAudio } from "@/lib/openai";
// Using string literals instead of Prisma enums for compatibility

// Schema para el formato de BuilderBot.cloud (permisivo: from puede venir como número, body puede faltar)
const builderbotWebhookSchema = z.object({
  eventName: z.string(),
  data: z.object({
    body: z.union([z.string(), z.number()]).optional(),
    name: z.union([z.string(), z.number()]).optional(),
    from: z.union([z.string(), z.number()]).transform(String),
    attachment: z.array(z.any()).optional(),
    urlTempFile: z.string().optional(),
    projectId: z.string().optional(),
  }).passthrough(),
});

/** Actualiza el resumen de la conversación con IA (no falla el webhook si falla). */
async function updateTicketSummary(ticketId: string) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.log("[Inbound] OPENAI_API_KEY no configurada, omitiendo resumen");
      return;
    }
    const messages = await prisma.ticketMessage.findMany({
      where: { ticketId },
      orderBy: { createdAt: "asc" },
    });
    if (messages.length === 0) return;
    const conversationMessages = messages.map((m) => ({
      from: m.from,
      text: m.text,
      createdAt: m.createdAt,
    }));
    const aiSummary = await summarizeConversation(conversationMessages);
    await prisma.ticket.update({
      where: { id: ticketId },
      data: { aiSummary },
    });
    console.log("[Inbound] ✅ Resumen actualizado para ticket", ticketId);
  } catch (error: any) {
    console.error("[Inbound] ⚠️ Error al actualizar resumen:", error?.message);
  }
}

/** Clasifica el tipo de caso con IA solo si el ticket aún no tiene legalType. */
async function classifyTicketTypeIfEmpty(ticketId: string) {
  try {
    if (!process.env.OPENAI_API_KEY) return;
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!ticket || ticket.legalType || ticket.messages.length === 0) return;
    const conversationMessages = ticket.messages.map((m) => ({
      from: m.from,
      text: m.text,
      createdAt: m.createdAt,
    }));
    const legalType = await classifyLegalType(conversationMessages);
    if (legalType) {
      await prisma.ticket.update({
        where: { id: ticketId },
        data: { legalType },
      });
      console.log("[Inbound] ✅ Tipo de caso asignado:", legalType);
    }
  } catch (error: any) {
    console.error("[Inbound] ⚠️ Error al clasificar tipo:", error?.message);
  }
}

/**
 * Ejecuta tareas de post-procesamiento sin bloquear la respuesta del webhook.
 * Si estas tareas tardan, el bot puede quedar "escribiendo" y cortar por timeout.
 */
function runPostProcessingAsync(ticketId: string) {
  void (async () => {
    try {
      await updateTicketSummary(ticketId);
      await classifyTicketTypeIfEmpty(ticketId);
    } catch (error: any) {
      console.error("[Inbound] ⚠️ Error en post-procesamiento async:", error?.message);
    }
  })();
}

export async function POST(req: Request) {
  const payload = await req.json().catch(() => null);
  if (!payload) {
    return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
  }

  console.log("📩 Webhook recibido de BuilderBot:", JSON.stringify(payload, null, 2));

  const parsed = builderbotWebhookSchema.safeParse(payload);
  if (!parsed.success) {
    console.error("❌ Formato inválido:", parsed.error.flatten());
    return NextResponse.json({ error: "Formato inválido", details: parsed.error.flatten() }, { status: 400 });
  }

  const { eventName, data } = parsed.data;

  // Procesar mensajes entrantes y salientes
  if (eventName === "message.incoming") {
    // Procesar mensaje entrante del cliente
    return await processIncomingMessage(parsed.data);
  } else if (eventName === "message.outgoing") {
    // Procesar mensaje saliente del agente desde BuilderBot
    return await processOutgoingMessage(parsed.data);
  } else {
    console.log(`ℹ️ Evento ignorado: ${eventName}`);
    return NextResponse.json({ ok: true, message: `Evento ${eventName} recibido pero no procesado` });
  }
}

async function processIncomingMessage({ eventName, data }: { eventName: string; data: any }) {

  let messageText = data.body != null ? String(data.body) : "";
  const customerPhone = String(data.from);
  const customerName = data.name; // Nombre de WhatsApp (la persona que escribe)
  const attachments = data.attachment || [];
  const urlTempFile = data.urlTempFile; // URL temporal de BuilderBot para multimedia

  // Algunos eventos de documentos/imágenes llegan con body de sistema tipo "_event_document__...".
  // Si hay adjuntos y el texto parece un marcador de evento, lo ocultamos y dejamos solo el adjunto.
  const trimmedBody = (messageText || "").trim();
  const isVoiceNote = /^_event_voice_note__/i.test(trimmedBody);
  const isAudioEvent = /^_event_audio__/i.test(trimmedBody);
  const isMediaEvent = /^_event_(document|image|video|audio)__/i.test(trimmedBody);

  if ((isMediaEvent || isVoiceNote) && attachments.length > 0) {
    messageText = "";
  }

  // Solo aceptar URLs absolutas para no guardar rutas relativas (evitar 404 al abrir el adjunto)
  const isAbsoluteUrl = (u: unknown) => typeof u === "string" && (u.startsWith("http://") || u.startsWith("https://"));

  // Procesar attachments (imágenes, videos, documentos)
  let processedAttachments = (
    await Promise.all(
      attachments.map(async (att: any) => {
        const tempUrl = att.url ?? att;
        if (!isAbsoluteUrl(tempUrl)) {
          console.warn(`⚠️ Adjunto con URL no absoluta ignorado (evitar 404): ${typeof tempUrl === "string" ? tempUrl : "[no string]"}`);
          return null;
        }
        const fileType = att.mimetype || getFileTypeFromUrl(tempUrl);
        try {
          const permanentUrl = await uploadToBlob(tempUrl, `attachment-${Date.now()}.${getFileExtension(tempUrl)}`);
          return { url: permanentUrl, type: fileType, name: att.filename || "archivo" };
        } catch (e: any) {
          console.error(`❌ Error subiendo adjunto:`, e?.message);
          return null;
        }
      })
    )
  ).filter((a): a is { url: string; type: string; name: string } => a != null);

  // Si viene urlTempFile pero no attachments, agregar el archivo temporal
  if (urlTempFile && processedAttachments.length === 0) {
    console.log(`📎 Archivo temporal detectado: ${urlTempFile}`);
    
    if (!urlTempFile.startsWith("http://") && !urlTempFile.startsWith("https://")) {
      console.error(`❌ urlTempFile no es URL absoluta: ${urlTempFile}`);
    } else {
      try {
        const permanentUrl = await uploadToBlob(urlTempFile, `media-${Date.now()}.${getFileExtension(urlTempFile)}`);
        // Si es nota de voz, forzar tipo "audio" sin importar la extensión de la URL
        const fileType = (isVoiceNote || isAudioEvent) ? "audio" : getFileTypeFromUrl(urlTempFile);
        
        processedAttachments.push({
          url: permanentUrl,
          type: fileType,
          name: (isVoiceNote || isAudioEvent || fileType === "audio") ? "Nota de voz" : "Archivo multimedia",
        });
        
        console.log(`✅ Archivo subido a Blob: ${permanentUrl} (tipo: ${fileType})`);
      } catch (error: any) {
        console.error(`❌ Error al procesar urlTempFile:`, error.message);
      }
    }
  }

  // --- TRANSCRIPCIÓN DE NOTAS DE VOZ con Whisper ---
  // BuilderBot Cloud NO reenvía la transcripción (confirmado por logs).
  // Transcribimos directamente desde urlTempFile (URL fresca) para mayor confiabilidad.
  if ((isVoiceNote || isAudioEvent) && !messageText) {
    // Preferir urlTempFile directo (más fresco) sobre la URL de Blob
    const audioUrl = (urlTempFile && isAbsoluteUrl(urlTempFile))
      ? urlTempFile
      : processedAttachments.find((a) => a.type === "audio")?.url || null;

    if (audioUrl) {
      console.log(`🎤 Transcribiendo nota de voz con Whisper...`);
      const transcription = await transcribeAudio(audioUrl);
      if (transcription) {
        messageText = transcription;
        console.log(`✅ Transcripción Whisper: "${messageText.slice(0, 100)}"`);
      } else {
        messageText = "[Nota de voz - no se pudo transcribir]";
        console.warn(`⚠️ Whisper no pudo transcribir la nota de voz`);
      }
    } else {
      messageText = "[Nota de voz]";
      console.warn(`⚠️ Nota de voz sin URL de audio disponible`);
    }
  }

  if (!messageText && processedAttachments.length === 0) {
    console.warn("⚠️ Mensaje sin texto ni attachments");
    return NextResponse.json({ ok: true, message: "Mensaje vacío, ignorado" });
  }

  // Parsear el mensaje inicial de BuilderBot
  // Formato esperado:
  // Línea 1: Nombre de la empresa
  // Línea 2: Nombre y rol del contacto
  // Línea 3+: Problema/consulta
  const lines = messageText.split("\n").map((l: string) => l.trim()).filter((l: string) => l.length > 0);
  let companyName = customerName || "Empresa desconocida";
  let contactName = customerName || "Sin nombre";
  let actualMessage = messageText;

  // Si el mensaje tiene al menos 3 líneas, asumimos que es el formato inicial del bot
  if (lines.length >= 3) {
    companyName = lines[0]; // Línea 1 = Empresa
    contactName = lines[1]; // Línea 2 = Contacto
    actualMessage = lines.slice(2).join("\n"); // Línea 3+ = Problema
    console.log(`📊 Parseado: Empresa="${companyName}", Contacto="${contactName}", Mensaje="${actualMessage}"`);
  } else {
    // Si no tiene el formato esperado, usar todo como mensaje
    console.log(`ℹ️ Mensaje no sigue formato inicial, usando texto completo`);
    contactName = customerName || "Sin nombre";
  }

  // Generar un messageId único basado en el contenido y timestamp
  const messageId = `${customerPhone}-${Date.now()}`;

  // Idempotencia por external message id
  const existing = await prisma.ticketMessage.findFirst({
    where: { 
      externalMessageId: messageId,
    },
  });
  
  if (existing) {
    console.log("ℹ️ Mensaje duplicado, ignorando");
    return NextResponse.json({
      ok: true,
      ticketId: existing.ticketId,
      idempotent: true,
    });
  }

  // Upsert customer: el nombre es la EMPRESA
  const customer = await prisma.customer.upsert({
    where: { phone: customerPhone },
    update: { name: companyName },
    create: { phone: customerPhone, name: companyName },
  });

  const cutoff = new Date(Date.now() - 1000 * 60 * 60 * 48);
  let ticket = await prisma.ticket.findFirst({
    where: {
      customerId: customer.id,
      status: { in: ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER"] },
      lastMessageAt: { gte: cutoff },
    },
    orderBy: { lastMessageAt: "desc" },
  });

  const isNewTicket = !ticket;

  if (!ticket) {
    ticket = await prisma.ticket.create({
      data: {
        code: generateTicketCode(),
        customerId: customer.id,
        contactName: contactName,
        title: actualMessage.split(" ").slice(0, 8).join(" ") || "Consulta",
        status: "OPEN",
        priority: "NORMAL",
        category: inferCategory(actualMessage) as "LABORAL" | "CIVIL" | "COMERCIAL" | "PENAL" | "FAMILIA" | "ADMINISTRATIVO" | "TRIBUTARIO" | "PREVISIONAL" | "OTRO",
        channel: "WHATSAPP",
      },
    });
    console.log(`🎫 Nuevo reclamo creado: ${ticket.code} - Empresa: ${companyName}, Contacto: ${contactName}`);
  } else {
    console.log(`🎫 Reclamo existente: ${ticket.code}`);
  }

  const heuristics = inferPriorityAndCategory(actualMessage, undefined, ticket.priority, ticket.category);

  const previousMessagesCount = await prisma.ticketMessage.count({ where: { ticketId: ticket.id } });

  const shouldEscalate = decideShouldEscalate({
    text: actualMessage,
    priority: heuristics.priority,
    previousMessages: previousMessagesCount,
  });

  const rawPayload = { eventName, data };

  await prisma.ticketMessage.create({
    data: {
      ticketId: ticket.id,
      direction: "INBOUND",
      from: "CUSTOMER",
      text: actualMessage || "[Archivo adjunto]",
      attachments: processedAttachments.length > 0 ? processedAttachments : undefined,
      rawPayload,
      externalMessageId: messageId,
    },
  });

  if (processedAttachments.length > 0) {
    console.log(`📎 ${processedAttachments.length} archivo(s) adjunto(s) guardado(s):`);
    processedAttachments.forEach((att, idx) => {
      console.log(`  ${idx + 1}. ${att.name} (${att.type}): ${att.url}`);
    });
  }

  // Solo actualizar prioridad y categoría en tickets NUEVOS; en existentes no pisar lo que definió la IA o el usuario
  const updateData: {
    priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
    category?: "LABORAL" | "CIVIL" | "COMERCIAL" | "PENAL" | "FAMILIA" | "ADMINISTRATIVO" | "TRIBUTARIO" | "PREVISIONAL" | "OTRO";
    status: "OPEN" | "IN_PROGRESS" | "WAITING_CUSTOMER" | "RESOLVED" | "CLOSED";
    lastMessageAt: Date;
  } = {
    status: shouldEscalate ? "IN_PROGRESS" : ticket.status,
    lastMessageAt: new Date(),
  };
  if (isNewTicket) {
    updateData.priority = heuristics.priority as "LOW" | "NORMAL" | "HIGH" | "URGENT";
    updateData.category = heuristics.category as "LABORAL" | "CIVIL" | "COMERCIAL" | "PENAL" | "FAMILIA" | "ADMINISTRATIVO" | "TRIBUTARIO" | "PREVISIONAL" | "OTRO";
  }
  await prisma.ticket.update({
    where: { id: ticket.id },
    data: updateData,
  });

  await prisma.ticketEvent.create({
    data: {
      ticketId: ticket.id,
      type: shouldEscalate ? "ESCALATED" : "AUTO_REPLY",
      payload: {
        message: actualMessage,
        company: companyName,
        contact: contactName,
        escalated: shouldEscalate,
      },
    },
  });

  // Decidir si enviar respuesta automática (no enviar si el bot está pausado para este cliente)
  let autoReplyMessage: string | null = null;
  if (customer.botPausedAt) {
    console.log(`⏸️ Cliente ${customerPhone} en pausa (bot pausado), no se envía auto-respuesta`);
  } else {
    // Verificar si el mensaje solicita contacto con agente de soporte
    const messageLower = actualMessage.toLowerCase();
    const solicitaAgente = /tenponder en contacto con un agente de soporte|poner en contacto con un agente|contactar con un agente|hablar con un agente|necesito hablar con un agente/i.test(messageLower);

    if (shouldEscalate && solicitaAgente) {
      autoReplyMessage = `Gracias por contactarnos, tu consulta ha sido escalada a nuestro equipo. Reclamo: *${ticket.code}*. Un abogado de nuestro equipo te contactará pronto.`;
    }
  }

  // Enviar respuesta automática si corresponde
  if (autoReplyMessage) {
    try {
      await sendWhatsAppMessage({
        number: customerPhone,
        message: autoReplyMessage,
      });
      console.log(`✅ Respuesta automática enviada a ${customerPhone}`);

      // Registrar la respuesta automática en el ticket
      await prisma.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          direction: "OUTBOUND",
          from: "BOT",
          text: autoReplyMessage,
          rawPayload: { autoReply: true, timestamp: new Date().toISOString() },
        },
      });
    } catch (error) {
      console.error("❌ Error al enviar respuesta automática:", error);
      // No fallar el webhook si falla el envío
    }
  }

  // Número de reclamo: solo al cerrar la interacción — despedida del cliente (entrante) o del bot en outgoing.
  const textForDespedida = (actualMessage || "").trim();
  if (!customer.botPausedAt && textForDespedida && isDespedida(textForDespedida)) {
    await sendTicketCodeAtFarewell({
      ticketId: ticket.id,
      ticketCode: ticket.code,
      customerPhone,
      peerText: textForDespedida,
      rawExtra: { atClienteDespedida: true },
    });
  }

  // Disparar IA en background para no bloquear webhook de BuilderBot
  runPostProcessingAsync(ticket.id);

  return NextResponse.json({ 
    ok: true, 
    ticketId: ticket.id, 
    ticketCode: ticket.code,
    escalated: shouldEscalate,
    autoReplySent: !!autoReplyMessage,
  });
}

/** Detecta si el mensaje del bot o del cliente parece una despedida / cierre del flujo (envío del código al final). */
function isDespedida(text: string): boolean {
  if (!text || !text.trim()) return false;
  const t = text.toLowerCase().trim();
  // Cierres muy frecuentes en WhatsApp (antes no matcheaban → no se enviaba el código)
  if (/\b(chau|chao)\b|nos vemos|que estés bien|que te vaya bien|cuídate|hasta luego|hasta pronto/i.test(t)) {
    return true;
  }
  // Agradecimiento breve de cierre (ej. "no nada gracias", "ok chau")
  if (t.length <= 88 && /^(ok\s*)?(no\s*,?\s*)?(nada\s*)?(gracias|muchas gracias|te agradezco)[\s!.,¡¿]*$/i.test(t)) {
    return true;
  }
  if (t.length <= 48 && /^(ok\s*)?(chau|chao|nos vemos)[\s!.,¡¿]*$/i.test(t)) {
    return true;
  }
  return (
    /un abogado (te )?contactar|nos pondremos en contacto|te responderemos pronto|abogado lo revisar/i.test(t) ||
    /(gracias por (contactar|escribir|comunicarte)|cualquier cosa escribinos|estamos en contacto)/i.test(t) ||
    /(despedida|hasta luego|que tengas buen|un abogado lo revisar)/i.test(t) ||
    /(reclamo.*revisar|revisar[aá].*pronto)/i.test(t) ||
    /(quedamos a disposici[oó]n|ante cualquier duda|saludos cordiales|muchas gracias)/i.test(t) ||
    /(en breve|a la brevedad|nos comunicaremos|te contactaremos)/i.test(t) ||
    /(tu consulta|tu mensaje).*(recibid|registrad|derivad)/i.test(t) ||
    /(perfecto|listo|de nada|con gusto)[^.]{0,40}(gracias|saludo)/i.test(t)
  );
}

/** Cierre “fuerte” (chau, que estés bien, etc.): si el código ya salió, igual conviene un recordatorio. */
function isDespedidaCierreFuerte(text: string): boolean {
  if (!text || !text.trim()) return false;
  const t = text.toLowerCase().trim();
  return /\b(chau|chao)\b|nos vemos|que estés bien|que te vaya bien|cuídate|hasta luego|hasta pronto/i.test(t);
}

async function outboundAlreadySentTicketCode(ticketId: string, code: string): Promise<boolean> {
  const found = await prisma.ticketMessage.findFirst({
    where: {
      ticketId,
      direction: "OUTBOUND",
      text: { contains: code },
    },
  });
  return !!found;
}

/** Evita reenviar el código / recordatorio si ya salió en un mensaje saliente reciente. */
async function recentOutboundWithTicketCode(
  ticketId: string,
  code: string,
  minutesAgo: number,
): Promise<boolean> {
  const since = new Date(Date.now() - minutesAgo * 60 * 1000);
  const found = await prisma.ticketMessage.findFirst({
    where: {
      ticketId,
      direction: "OUTBOUND",
      text: { contains: code },
      createdAt: { gte: since },
    },
  });
  return !!found;
}

/** Primer envío del código en cierre: tono de cierre, sin “Hola / hemos recibido” (eso confunde tras la despedida del abogado). */
const FIRST_FAREWELL_TICKET_CODE_MESSAGE = (code: string) =>
  `Tu reclamo es *${code}*. Guardá este número para cualquier consulta.`;

const REMINDER_TICKET_CODE_MESSAGE = (code: string) =>
  `Recordatorio: tu reclamo es *${code}*. Guardá este número para cualquier consulta.`;

async function sendTicketCodeAtFarewell(opts: {
  ticketId: string;
  ticketCode: string;
  customerPhone: string;
  peerText: string;
  rawExtra: Record<string, unknown>;
  botPaused?: boolean;
}): Promise<void> {
  const { ticketId, ticketCode, customerPhone, peerText, rawExtra, botPaused } = opts;
  if (botPaused) return;

  const yaEnviado = await outboundAlreadySentTicketCode(ticketId, ticketCode);
  if (!yaEnviado) {
    const firstFarewellMessage = FIRST_FAREWELL_TICKET_CODE_MESSAGE(ticketCode);
    try {
      await sendWhatsAppMessage({ number: customerPhone, message: firstFarewellMessage });
      await prisma.ticketMessage.create({
        data: {
          ticketId,
          direction: "OUTBOUND",
          from: "BOT",
          text: firstFarewellMessage,
          rawPayload: { autoReply: true, ...rawExtra, timestamp: new Date().toISOString() },
        },
      });
      console.log(`✅ Código de reclamo enviado al cierre (${ticketCode})`);
    } catch (err) {
      console.error("❌ Error al enviar mensaje con código al cierre:", err);
    }
    return;
  }

  if (
    isDespedidaCierreFuerte(peerText) &&
    !(await recentOutboundWithTicketCode(ticketId, ticketCode, 25))
  ) {
    const reminder = REMINDER_TICKET_CODE_MESSAGE(ticketCode);
    try {
      await sendWhatsAppMessage({ number: customerPhone, message: reminder });
      await prisma.ticketMessage.create({
        data: {
          ticketId,
          direction: "OUTBOUND",
          from: "BOT",
          text: reminder,
          rawPayload: { autoReply: true, recordatorioCodigo: true, ...rawExtra, timestamp: new Date().toISOString() },
        },
      });
      console.log(`✅ Recordatorio de reclamo enviado (${ticketCode})`);
    } catch (err) {
      console.error("❌ Error al enviar recordatorio de código:", err);
    }
  }
}

async function processOutgoingMessage({ eventName, data }: { eventName: string; data: any }) {
  const messageText = data.body || "";
  // En mensajes salientes, el destinatario puede estar en 'to', 'remoteJid', o 'key.remoteJid'
  const customerPhone = data.to || data.remoteJid || data.key?.remoteJid || data.from;
  const attachments = data.attachment || [];
  const urlTempFile = data.urlTempFile;

  if (!customerPhone) {
    console.warn("⚠️ Mensaje saliente sin destinatario");
    return NextResponse.json({ ok: true, message: "Mensaje saliente sin destinatario, ignorado" });
  }

  if (!messageText && attachments.length === 0 && !urlTempFile) {
    console.warn("⚠️ Mensaje saliente sin texto ni attachments");
    return NextResponse.json({ ok: true, message: "Mensaje saliente vacío, ignorado" });
  }

  const isAbsoluteUrlOut = (u: unknown) => typeof u === "string" && (u.startsWith("http://") || u.startsWith("https://"));

  let processedAttachments = (
    await Promise.all(
      attachments.map(async (att: any) => {
        const tempUrl = att.url ?? att;
        if (!isAbsoluteUrlOut(tempUrl)) {
          console.warn(`⚠️ [Outgoing] Adjunto con URL no absoluta ignorado: ${typeof tempUrl === "string" ? tempUrl : "[no string]"}`);
          return null;
        }
        try {
          const fileType = att.mimetype || getFileTypeFromUrl(tempUrl);
          const permanentUrl = await uploadToBlob(tempUrl, `attachment-${Date.now()}.${getFileExtension(tempUrl)}`);
          return { url: permanentUrl, type: fileType, name: att.filename || "archivo" };
        } catch (e: any) {
          console.error(`❌ [Outgoing] Error subiendo adjunto:`, e?.message);
          return null;
        }
      })
    )
  ).filter((a): a is { url: string; type: string; name: string } => a != null);

  if (urlTempFile && processedAttachments.length === 0) {
    if (urlTempFile.startsWith("http://") || urlTempFile.startsWith("https://")) {
      try {
        const permanentUrl = await uploadToBlob(urlTempFile, `media-${Date.now()}.${getFileExtension(urlTempFile)}`);
        processedAttachments.push({
          url: permanentUrl,
          type: getFileTypeFromUrl(urlTempFile),
          name: "Archivo multimedia",
        });
      } catch (error: any) {
        console.error(`❌ Error al procesar urlTempFile:`, error.message);
      }
    }
  }

  // Buscar el ticket activo para este cliente
  const customer = await prisma.customer.findUnique({
    where: { phone: customerPhone },
  });

  if (!customer) {
    console.log(`ℹ️ Cliente no encontrado para ${customerPhone}, ignorando mensaje saliente`);
    return NextResponse.json({ ok: true, message: "Cliente no encontrado" });
  }

  // Buscar ticket activo (últimas 48 horas)
  const cutoff = new Date(Date.now() - 1000 * 60 * 60 * 48);
  const ticket = await prisma.ticket.findFirst({
    where: {
      customerId: customer.id,
      status: { in: ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER"] },
      lastMessageAt: { gte: cutoff },
    },
    orderBy: { lastMessageAt: "desc" },
  });

  if (!ticket) {
    console.log(`ℹ️ No hay ticket activo para ${customerPhone}, ignorando mensaje saliente`);
    return NextResponse.json({ ok: true, message: "No hay ticket activo" });
  }

  // Evitar duplicado: si el agente envió desde el backoffice, ya guardamos HUMAN; no guardar de nuevo como BOT
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
  const normalizedIncoming = (messageText || "[Archivo adjunto]").trim().replace(/\s+/g, " ");
  const recentOutbound = await prisma.ticketMessage.findMany({
    where: {
      ticketId: ticket.id,
      direction: "OUTBOUND",
      createdAt: { gte: twoMinutesAgo },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  for (const msg of recentOutbound) {
    const existingNormalized = (msg.text || "").trim().replace(/\s+/g, " ");
    if (existingNormalized === normalizedIncoming || existingNormalized.includes(normalizedIncoming) || normalizedIncoming.includes(existingNormalized)) {
      console.log(`ℹ️ Mensaje saliente ya existe (enviado desde backoffice como Agente), no duplicar como Bot`);
      return NextResponse.json({
        ok: true,
        ticketId: ticket.id,
        ticketCode: ticket.code,
        duplicate: true,
        existingMessageId: msg.id,
      });
    }
  }

  // Generar messageId único
  const messageId = `outgoing-${customerPhone}-${Date.now()}`;

  // Verificar idempotencia por externalMessageId
  const existingById = await prisma.ticketMessage.findFirst({
    where: { 
      externalMessageId: messageId,
    },
  });
  
  if (existingById) {
    console.log("ℹ️ Mensaje saliente duplicado por ID, ignorando");
    return NextResponse.json({
      ok: true,
      ticketId: existingById.ticketId,
      idempotent: true,
    });
  }

  const rawPayload = { eventName, data };

  // Guardar el mensaje saliente del agente desde BuilderBot
  await prisma.ticketMessage.create({
    data: {
      ticketId: ticket.id,
      direction: "OUTBOUND",
      from: "BOT", // Mensaje enviado por agente desde BuilderBot, se muestra como bot (verde)
      text: messageText || "[Archivo adjunto]",
      attachments: processedAttachments.length > 0 ? processedAttachments : undefined,
      rawPayload,
      externalMessageId: messageId,
    },
  });

  // Actualizar el ticket
  await prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      lastMessageAt: new Date(),
      status: "WAITING_CUSTOMER", // El abogado envió un mensaje, ahora esperamos respuesta del cliente
    },
  });

  // Si el bot/agente envía una despedida: enviar código o recordatorio al cierre fuerte
  if (isDespedida(messageText)) {
    await sendTicketCodeAtFarewell({
      ticketId: ticket.id,
      ticketCode: ticket.code,
      customerPhone: customer.phone,
      peerText: String(messageText || ""),
      rawExtra: { atDespedida: true },
      botPaused: !!customer.botPausedAt,
    });
  }

  // Disparar IA en background para no bloquear webhook de BuilderBot
  runPostProcessingAsync(ticket.id);

  console.log(`✅ Mensaje saliente del abogado guardado en reclamo ${ticket.code}`);

  return NextResponse.json({ 
    ok: true, 
    ticketId: ticket.id, 
    ticketCode: ticket.code,
    messageSaved: true,
  });
}

function inferPriorityAndCategory(
  text: string,
  metadata: Record<string, unknown> | undefined,
  currentPriority: string,
  currentCategory: string,
) {
  const lower = text.toLowerCase();
  let priority: string = currentPriority;
  let category: string = currentCategory;

  if (/(urgente|producci[óo]n|ca[ií]do|no anda|error)/.test(lower)) {
    priority = "HIGH";
  }
  if (/(amenaza|legal|fraude|cliente enojado)/.test(lower)) {
    priority = "URGENT";
  }
  // Detección de categorías legales básicas
  if (/(laboral|despido|trabajo|empleado|empleador|sueldo|salario)/.test(lower)) {
    category = "LABORAL";
  }
  if (/(civil|contrato|daño|responsabilidad|propiedad)/.test(lower)) {
    category = "CIVIL";
  }
  if (/(comercial|empresa|sociedad|factura|pago|precio)/.test(lower)) {
    category = "COMERCIAL";
  }
  if (/(penal|delito|robo|hurto|fraude)/.test(lower)) {
    category = "PENAL";
  }
  if (/(familia|divorcio|alimentos|patria|potestad)/.test(lower)) {
    category = "FAMILIA";
  }
  if (/(tributario|afip|impuesto|ganancias|iva)/.test(lower)) {
    category = "TRIBUTARIO";
  }
  if (metadata && typeof metadata["priority"] === "string") {
    const metaPriority = metadata["priority"] as string;
    if (metaPriority.toLowerCase() === "urgent") {
      priority = "URGENT";
    }
  }
  return { priority, category };
}

function inferCategory(text: string): string {
  const lower = text.toLowerCase();
  // Detección de categorías legales básicas
  if (/(laboral|despido|trabajo|empleado|empleador|sueldo|salario)/.test(lower)) return "LABORAL";
  if (/(civil|contrato|daño|responsabilidad|propiedad)/.test(lower)) return "CIVIL";
  if (/(comercial|empresa|sociedad|factura|pago|precio)/.test(lower)) return "COMERCIAL";
  if (/(penal|delito|robo|hurto|fraude)/.test(lower)) return "PENAL";
  if (/(familia|divorcio|alimentos|patria|potestad)/.test(lower)) return "FAMILIA";
  if (/(tributario|afip|impuesto|ganancias|iva)/.test(lower)) return "TRIBUTARIO";
  return "OTRO";
}

function decideShouldEscalate({
  text,
  priority,
  previousMessages,
}: {
  text: string;
  priority: string;
  previousMessages: number;
}): boolean {
  const lower = text.toLowerCase();

  // Escalate if priority is URGENT
  if (priority === "URGENT") {
    return true;
  }

  // Escalate if contains critical keywords
  if (/(amenaza|legal|fraude|cliente enojado|escala|denuncia)/.test(lower)) {
    return true;
  }

  // Escalate if there are already 3+ messages in the ticket
  if (previousMessages >= 3) {
    return true;
  }

  return false;
}

function getFileTypeFromUrl(url: string): string {
  if (!url) return "unknown";
  const lowerUrl = url.toLowerCase();
  if (/(jpg|jpeg|png|gif|webp)/.test(lowerUrl)) return "image";
  if (/(mp4|mov|avi|webm)/.test(lowerUrl)) return "video";
  if (/(pdf)/.test(lowerUrl)) return "pdf";
  if (/(mp3|wav|ogg|m4a)/.test(lowerUrl)) return "audio";
  if (/(doc|docx|xls|xlsx|ppt|pptx)/.test(lowerUrl)) return "document";
  return "file";
}

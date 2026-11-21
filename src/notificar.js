// Envia-te um SMS com o resumo de cada chamada (via Twilio).
import twilio from "twilio";

export function criarNotificador() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMERO } = process.env;
  const cliente =
    TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

  return {
    async sms(para, texto) {
      if (!cliente || !TWILIO_NUMERO || !para) {
        console.log(`[notificação não enviada — falta configurar Twilio/número]\n${texto}`);
        return false;
      }
      await cliente.messages.create({ from: TWILIO_NUMERO, to: para, body: texto.slice(0, 1500) });
      return true;
    },
  };
}

export function textoResumo(chamada) {
  const r = chamada.resumo;
  const icone = { alta: "🔴 URGENTE", media: "🟠", baixa: "🟢" }[r?.urgencia] || "📞";
  if (!r) return `📞 Chamada de ${chamada.nomeContacto || chamada.de || "número privado"} (sem resumo).`;
  return [
    `${icone} Chamada atendida pela IA`,
    `De: ${r.quem}${chamada.de ? ` (${chamada.de})` : ""}`,
    `Assunto: ${r.assunto}`,
    r.contactoDeixado ? `Contacto: ${r.contactoDeixado}` : null,
    `Fazer: ${r.acao}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Envia-te um SMS com o resumo de cada chamada (via Twilio).
import twilio from "twilio";
import { redigir } from "./privacidade.js";

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

// SMS curto, fácil de ler no ecrã bloqueado: QUEM | ASSUNTO | AÇÃO
export function textoResumo(chamada) {
  const r = chamada.resumo;
  const numero = chamada.de || "número privado";
  const linhas = [];
  if (chamada.possivelBurla) linhas.push("⚠️ POSSÍVEL BURLA — não devolvas a chamada sem confirmar");
  if (!r) {
    linhas.push(`📞 ${chamada.nomeContacto || numero} | ligou | ver painel`);
  } else {
    const icone = { alta: "🔴", media: "🟠", baixa: "🟢" }[r.urgencia] || "📞";
    linhas.push(`${icone} ${r.quem} | ${r.assunto} | ${r.acao}`);
    linhas.push(`📞 ${r.contactoDeixado || numero}`);
  }
  if (chamada.ambigua) linhas.push("(conversa confusa — vê a transcrição)");
  return redigir(linhas.join("\n"));
}

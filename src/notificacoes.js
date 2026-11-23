// Notificações push (como uma app): lembretes à hora das tarefas e resumo
// da manhã. Funciona no iPhone (iOS 16.4+) com a app adicionada ao ecrã
// principal, e em Android/computador no Chrome, Edge ou Firefox.
import * as webpush from "web-push";

const FUSO = "Europe/Lisbon";
const MAX_SUBSCRICOES = 10;
const JANELA_ATRASO = 6 * 3600_000; // não avisa tarefas que passaram há mais de 6 h

// Data (AAAA-MM-DD) e hora (HH:MM) de Lisboa.
export function horaLisboa(agora = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(agora)
      .map((x) => [x.type, x.value]),
  );
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}

export function criarNotificacoes({ armazem, enviar = webpush.sendNotification }) {
  // Chaves VAPID: variáveis de ambiente, ou geradas uma vez e guardadas.
  let chaves =
    process.env.VAPID_PUBLICA && process.env.VAPID_PRIVADA
      ? { publicKey: process.env.VAPID_PUBLICA, privateKey: process.env.VAPID_PRIVADA }
      : armazem.lerValor("vapid", null);
  if (!chaves) {
    chaves = webpush.generateVAPIDKeys();
    armazem.guardarValor("vapid", chaves);
  }
  const vapid = {
    subject: process.env.VAPID_CONTACTO || "mailto:assistente@assistente-ia.app",
    publicKey: chaves.publicKey,
    privateKey: chaves.privateKey,
  };

  const lerSubs = () => armazem.lerValor("subscricoes", []);

  async function enviarATodos(mensagem) {
    const subs = lerSubs();
    const ficam = [];
    let enviadas = 0;
    for (const sub of subs) {
      try {
        await enviar(sub, JSON.stringify(mensagem), { vapidDetails: vapid, TTL: 6 * 3600 });
        enviadas++;
        ficam.push(sub);
      } catch (erro) {
        // 404/410: o telemóvel cancelou a subscrição; as outras falhas ficam.
        if (erro.statusCode === 404 || erro.statusCode === 410) console.log("Notificações: subscrição expirada removida.");
        else {
          console.error("Notificações: falha a enviar:", erro.statusCode || "", erro.message);
          ficam.push(sub);
        }
      }
    }
    if (ficam.length !== subs.length) armazem.guardarValor("subscricoes", ficam);
    return enviadas;
  }

  let aVerificar = false;
  return {
    chavePublica: vapid.publicKey,

    subscrever(sub) {
      if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
        throw new Error("Subscrição inválida.");
      }
      const limpa = { endpoint: sub.endpoint.slice(0, 1000), keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 100) } };
      const subs = lerSubs().filter((s) => s.endpoint !== limpa.endpoint);
      subs.push(limpa);
      armazem.guardarValor("subscricoes", subs.slice(-MAX_SUBSCRICOES));
      return subs.length;
    },

    total: () => lerSubs().length,

    enviarATodos,

    // Corre de minuto a minuto (e quando o servidor acorda): avisa as tarefas
    // que chegaram à hora e manda o resumo da manhã uma vez por dia.
    async verificar(agora = new Date()) {
      if (aVerificar || !lerSubs().length) return [];
      aVerificar = true;
      const enviadas = [];
      try {
        const avisadas = armazem.lerValor("notificadas", {});
        const t = agora.getTime();
        for (const tarefa of armazem.lerTarefas()) {
          if (tarefa.feita || !tarefa.quando || avisadas[tarefa.id]) continue;
          const quando = Date.parse(tarefa.quando);
          if (!(quando <= t && quando > t - JANELA_ATRASO)) continue;
          avisadas[tarefa.id] = agora.toISOString();
          await enviarATodos({ titulo: `⏰ ${tarefa.titulo}`, corpo: tarefa.notas || "Está na hora.", url: "/?sec=tarefas", tag: `tarefa-${tarefa.id}` });
          enviadas.push(tarefa.titulo);
        }
        // Esquece avisos com mais de 7 dias.
        for (const [id, iso] of Object.entries(avisadas)) if (Date.parse(iso) < t - 7 * 86_400_000) delete avisadas[id];
        armazem.guardarValor("notificadas", avisadas);

        // Resumo da manhã.
        const config = armazem.lerConfig();
        const { dia, hora } = horaLisboa(agora);
        if (config.resumoAtivo && hora >= config.horaResumo && armazem.lerValor("resumoEnviado", "") !== dia) {
          armazem.guardarValor("resumoEnviado", dia);
          const deHoje = armazem
            .lerTarefas()
            .filter((x) => !x.feita && x.quando && horaLisboa(new Date(x.quando)).dia === dia)
            .sort((a, b) => (a.quando < b.quando ? -1 : 1));
          const atrasadas = armazem.lerTarefas().filter((x) => !x.feita && x.quando && Date.parse(x.quando) < t && horaLisboa(new Date(x.quando)).dia < dia);
          const nome = config.nomeAssistente || "Íris";
          const linhas = deHoje.slice(0, 4).map((x) => `${horaLisboa(new Date(x.quando)).hora} ${x.titulo}`);
          const corpo = [
            deHoje.length ? `Hoje tens ${deHoje.length} tarefa(s):` : "Hoje não tens tarefas marcadas. 🎉",
            ...linhas,
            atrasadas.length ? `⚠️ ${atrasadas.length} atrasada(s).` : "",
          ].filter(Boolean).join("\n");
          await enviarATodos({ titulo: `☀️ Bom dia! — ${nome}`, corpo, url: "/?sec=tarefas", tag: `resumo-${dia}` });
          enviadas.push("resumo");
        }
      } finally {
        aVerificar = false;
      }
      return enviadas;
    },
  };
}

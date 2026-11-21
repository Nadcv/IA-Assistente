// Webhooks do Twilio: a IA atende chamadas reencaminhadas do teu telemóvel.
//
// Fluxo: Twilio liga para /voz/entrada -> a IA diz a saudação e ouve
// (<Gather input="speech">) -> o que a pessoa disse chega a /voz/resposta ->
// o Claude decide a próxima fala -> repete até terminar. Quando a chamada
// acaba, /voz/estado gera o resumo e manda-te um SMS.
import express from "express";
import twilio from "twilio";
import { saudacao } from "./ia.js";
import { nomeDoContacto } from "./armazem.js";
import { textoResumo } from "./notificar.js";

const VOZ = { voice: process.env.TWILIO_VOZ || "Polly.Ines-Neural", language: "pt-PT" };
const MAX_TURNOS = 12; // corta conversas intermináveis (custo e abusos)

export function rotasVoz({ ia, armazem, notificador }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  router.use(validarAssinaturaTwilio);

  const emCurso = new Map(); // CallSid -> chamada

  const ouvir = (resp, texto) => {
    const g = resp.gather({
      input: "speech",
      language: "pt-PT",
      speechTimeout: "auto",
      action: "/voz/resposta",
      method: "POST",
      actionOnEmptyResult: true,
    });
    g.say(VOZ, texto);
  };

  router.post("/entrada", (req, res) => {
    const config = armazem.lerConfig();
    const resp = new twilio.twiml.VoiceResponse();
    if (!config.ativo) {
      resp.say(VOZ, "Neste momento não é possível atender. Por favor, ligue mais tarde.");
      resp.hangup();
      return res.type("text/xml").send(resp.toString());
    }
    const de = req.body.From || "";
    const nomeContacto = nomeDoContacto(config.contactos, de);
    const chamada = {
      id: req.body.CallSid,
      de,
      nomeContacto,
      inicio: new Date().toISOString(),
      turnos: [],
      silencios: 0,
    };
    chamada.saudacao = saudacao(config, nomeContacto);
    chamada.turnos.push({ quem: "ia", texto: chamada.saudacao });
    emCurso.set(chamada.id, chamada);
    ouvir(resp, chamada.saudacao);
    res.type("text/xml").send(resp.toString());
  });

  router.post("/resposta", async (req, res) => {
    const resp = new twilio.twiml.VoiceResponse();
    const chamada = emCurso.get(req.body.CallSid);
    if (!chamada) {
      resp.say(VOZ, "Desculpe, houve um problema. Por favor, ligue novamente.");
      resp.hangup();
      return res.type("text/xml").send(resp.toString());
    }
    const falou = (req.body.SpeechResult || "").trim();

    if (!falou) {
      chamada.silencios += 1;
      if (chamada.silencios >= 2) {
        resp.say(VOZ, "Não estou a conseguir ouvir. Vou avisar que ligou. Até logo!");
        resp.hangup();
      } else {
        ouvir(resp, "Desculpe, não ouvi. Pode repetir?");
      }
      return res.type("text/xml").send(resp.toString());
    }

    chamada.turnos.push({ quem: "pessoa", texto: falou });
    let fala, terminar;
    try {
      ({ fala, terminar } = await ia.turnoChamada(armazem.lerConfig(), chamada));
    } catch (erro) {
      console.error("Erro da IA na chamada:", erro.message);
      fala = "Desculpe, tive um problema técnico. Já ficou registado que ligou e vão ligar-lhe de volta. Até logo!";
      terminar = true;
    }
    const iaTurnos = chamada.turnos.filter((t) => t.quem === "ia").length;
    if (!terminar && iaTurnos >= MAX_TURNOS) {
      fala += " Já tenho o seu recado. Obrigado, até logo!";
      terminar = true;
    }
    chamada.turnos.push({ quem: "ia", texto: fala });
    if (terminar) {
      resp.say(VOZ, fala);
      resp.hangup();
    } else {
      ouvir(resp, fala);
    }
    res.type("text/xml").send(resp.toString());
  });

  // Configura no Twilio: "Call status changes" -> POST /voz/estado
  router.post("/estado", async (req, res) => {
    res.sendStatus(204); // responde já; o resumo é feito a seguir
    const estadosFinais = ["completed", "busy", "failed", "no-answer", "canceled"];
    if (!estadosFinais.includes(req.body.CallStatus)) return;
    const chamada = emCurso.get(req.body.CallSid);
    if (!chamada) return;
    emCurso.delete(chamada.id);
    await finalizarChamada({ ia, armazem, notificador }, chamada, req.body.CallDuration);
  });

  // Rede de segurança: se o callback de estado não estiver configurado,
  // fecha chamadas com mais de 30 minutos para não se perderem.
  const limpeza = setInterval(() => {
    const limite = Date.now() - 30 * 60_000;
    for (const [id, chamada] of emCurso) {
      if (Date.parse(chamada.inicio) < limite) {
        emCurso.delete(id);
        finalizarChamada({ ia, armazem, notificador }, chamada).catch(() => {});
      }
    }
  }, 5 * 60_000);
  limpeza.unref();

  router.emCurso = emCurso;
  return router;
}

export async function finalizarChamada({ ia, armazem, notificador }, chamada, duracao) {
  chamada.fim = new Date().toISOString();
  chamada.duracaoSeg = Number(duracao) || null;
  delete chamada.silencios;
  const config = armazem.lerConfig();
  try {
    chamada.resumo = await ia.resumirChamada(config, chamada);
  } catch (erro) {
    console.error("Erro ao resumir chamada:", erro.message);
    chamada.resumo = null;
  }
  armazem.guardarChamada(chamada);
  try {
    await notificador.sms(config.numeroNotificacoes || process.env.NUMERO_NOTIFICACOES, textoResumo(chamada));
  } catch (erro) {
    console.error("Erro ao enviar SMS:", erro.message);
  }
}

// Só aceita pedidos assinados pelo Twilio (impede que alguém finja chamadas
// e gaste os teus créditos). Desliga com TWILIO_VALIDAR=false só em testes.
function validarAssinaturaTwilio(req, res, next) {
  if (process.env.TWILIO_VALIDAR === "false") return next();
  const token = process.env.TWILIO_AUTH_TOKEN;
  const base = process.env.PUBLIC_URL;
  if (!token || !base) {
    console.error("Falta TWILIO_AUTH_TOKEN ou PUBLIC_URL para validar o Twilio");
    return res.sendStatus(503);
  }
  const url = base.replace(/\/$/, "") + req.originalUrl;
  const ok = twilio.validateRequest(token, req.get("X-Twilio-Signature") || "", url, req.body || {});
  if (!ok) return res.sendStatus(403);
  next();
}

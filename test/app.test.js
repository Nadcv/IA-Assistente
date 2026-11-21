import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TWILIO_VALIDAR = "false";
const { criarApp } = await import("../src/server.js");
const { criarArmazem, nomeDoContacto } = await import("../src/armazem.js");
const { criarIA } = await import("../src/ia.js");

let servidor, base, pasta;
const sms = [];
const falas = [];

// IA falsa: termina a conversa à segunda fala da pessoa.
const iaFalsa = {
  async turnoChamada(config, chamada) {
    falas.push(chamada.turnos.map((t) => t.quem).join(","));
    const n = chamada.turnos.filter((t) => t.quem === "pessoa").length;
    return n >= 2
      ? { fala: "Obrigado, vou passar o recado. Até logo!", terminar: true }
      : { fala: "Pode dizer-me o seu nome?", terminar: false };
  },
  async resumirChamada() {
    return { quem: "Rui", assunto: "Orçamento da obra", urgencia: "alta", acao: "Ligar hoje", contactoDeixado: "" };
  },
  async sugerirResposta(config, { mensagem }) {
    return { sugestoes: [`Resposta a: ${mensagem}`, "B", "C"], nota: "" };
  },
};

before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), "assistente-"));
  const armazem = criarArmazem(pasta);
  armazem.guardarConfig({ nomeDono: "Ana", contactos: "Rui Obras: +351 912 345 678", numeroNotificacoes: "+351900000000" });
  const notificador = { async sms(para, texto) { sms.push({ para, texto }); return true; } };
  const app = criarApp({ ia: iaFalsa, armazem, notificador, senha: "segredo123" });
  servidor = app.listen(0);
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => { servidor.close(); fs.rmSync(pasta, { recursive: true, force: true }); });

const twilioPost = (caminho, dados) =>
  fetch(base + caminho, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(dados),
  });

test("reconhece contactos pelos últimos 9 dígitos", () => {
  assert.equal(nomeDoContacto("Rui: +351 912 345 678", "912345678"), "Rui");
  assert.equal(nomeDoContacto("Rui: +351912345678", "00351912345678"), "Rui");
  assert.equal(nomeDoContacto("Rui: 112", "112"), null);
  assert.equal(nomeDoContacto("Rui: +351912345678", "+351999999999"), null);
});

test("chamada completa: saudação, conversa, fim e SMS com resumo", async () => {
  let r = await twilioPost("/voz/entrada", { CallSid: "CA1", From: "+351912345678" });
  let xml = await r.text();
  assert.match(xml, /<Gather[^>]*input="speech"/);
  assert.match(xml, /Olá Rui Obras! Fala o assistente virtual de Ana/);

  r = await twilioPost("/voz/resposta", { CallSid: "CA1", SpeechResult: "Queria falar com a Ana" });
  xml = await r.text();
  assert.match(xml, /Pode dizer-me o seu nome\?/);
  assert.match(xml, /<Gather/);

  r = await twilioPost("/voz/resposta", { CallSid: "CA1", SpeechResult: "Sou o Rui, é sobre o orçamento" });
  xml = await r.text();
  assert.match(xml, /vou passar o recado/);
  assert.match(xml, /<Hangup\/>/);
  assert.deepEqual(falas, ["ia,pessoa", "ia,pessoa,ia,pessoa"]);

  r = await twilioPost("/voz/estado", { CallSid: "CA1", CallStatus: "completed", CallDuration: "40" });
  assert.equal(r.status, 204);
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(sms.length, 1);
  assert.equal(sms[0].para, "+351900000000");
  assert.match(sms[0].texto, /URGENTE/);
  assert.match(sms[0].texto, /Orçamento da obra/);
});

test("silêncio duas vezes desliga educadamente", async () => {
  await twilioPost("/voz/entrada", { CallSid: "CA2", From: "+351911111111" });
  let xml = await (await twilioPost("/voz/resposta", { CallSid: "CA2" })).text();
  assert.match(xml, /não ouvi/);
  xml = await (await twilioPost("/voz/resposta", { CallSid: "CA2" })).text();
  assert.match(xml, /<Hangup\/>/);
});

test("pedidos sem assinatura do Twilio são rejeitados quando a validação está ligada", async () => {
  process.env.TWILIO_VALIDAR = "true";
  process.env.TWILIO_AUTH_TOKEN = "x";
  process.env.PUBLIC_URL = base;
  try {
    const r = await twilioPost("/voz/entrada", { CallSid: "CA3" });
    assert.equal(r.status, 403);
  } finally {
    process.env.TWILIO_VALIDAR = "false";
  }
});

test("painel exige palavra-passe e devolve chamadas e sugestões", async () => {
  let r = await fetch(base + "/api/chamadas");
  assert.equal(r.status, 401);

  r = await fetch(base + "/api/entrar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ senha: "errada" }) });
  assert.equal(r.status, 401);

  r = await fetch(base + "/api/entrar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ senha: "segredo123" }) });
  const { token } = await r.json();
  const h = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

  const chamadas = await (await fetch(base + "/api/chamadas", { headers: h })).json();
  assert.equal(chamadas[0].id, "CA1");
  assert.equal(chamadas[0].resumo.quem, "Rui");

  r = await fetch(base + "/api/sugerir", { method: "POST", headers: h, body: JSON.stringify({ mensagem: "Olá!", plataforma: "Instagram" }) });
  const s = await r.json();
  assert.equal(s.sugestoes[0], "Resposta a: Olá!");

  r = await fetch(base + "/api/config", { method: "PUT", headers: h, body: JSON.stringify({ ativo: false, hack: 1 }) });
  const c = await r.json();
  assert.equal(c.ativo, false);
  assert.equal(c.hack, undefined);

  const xml = await (await twilioPost("/voz/entrada", { CallSid: "CA4" })).text();
  assert.match(xml, /não é possível atender/);
});

test("ia.js envia pedido correto ao Claude e lê o JSON", async () => {
  let pedido;
  const clienteFalso = {
    beta: { messages: { async create(params) {
      pedido = params;
      return { stop_reason: "end_turn", content: [{ type: "text", text: '{"fala":"Olá","terminar":false}' }] };
    } } },
  };
  const ia = criarIA(clienteFalso);
  const chamada = { de: "+351", saudacao: "Olá!", turnos: [{ quem: "ia", texto: "Olá!" }, { quem: "pessoa", texto: "Bom dia" }] };
  const r = await ia.turnoChamada({ nomeDono: "Ana", instrucoes: "x" }, chamada);
  assert.deepEqual(r, { fala: "Olá", terminar: false });
  assert.equal(pedido.model, "claude-opus-5-5");
  assert.equal(pedido.fallbacks, "default");
  assert.equal(pedido.output_config.format.type, "json_schema");
  assert.deepEqual(pedido.messages, [{ role: "user", content: "Bom dia" }]);

  clienteFalso.beta.messages.create = async () => ({ stop_reason: "refusal", content: [] });
  await assert.rejects(ia.turnoChamada({ nomeDono: "Ana", instrucoes: "x" }, chamada), /recusou/);
});

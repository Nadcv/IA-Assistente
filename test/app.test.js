import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TWILIO_VALIDAR = "false";
const { criarApp } = await import("../src/server.js");
const { criarArmazem, nomeDoContacto, estaNaLista } = await import("../src/armazem.js");
const { redigir } = await import("../src/privacidade.js");
const { criarIA, motorClaude, motorGemini, qualIA, custoIA } = await import("../src/ia.js");

let servidor, base, pasta, armazemTeste;
const sms = [];
const falas = [];

// IA falsa: termina a conversa à segunda fala da pessoa; reage a palavras-chave.
const iaFalsa = {
  modelo: "claude-opus-5-5",
  async turnoChamada(config, chamada) {
    const ultima = chamada.turnos.at(-1).texto;
    chamada.tokens.entrada = (chamada.tokens.entrada || 0) + 1000;
    chamada.tokens.saida = (chamada.tokens.saida || 0) + 100;
    if (/banco/.test(ultima)) return { fala: "Claro, diga o código.", terminar: false, entendeu: true, risco: "alto" };
    if (/blablabla/.test(ultima)) return { fala: "Como?", terminar: false, entendeu: false, risco: "baixo" };
    if (chamada.id !== "CA1") return { fala: "Diga.", terminar: false, entendeu: true, risco: "baixo" };
    falas.push(chamada.turnos.map((t) => t.quem).join(","));
    const n = chamada.turnos.filter((t) => t.quem === "pessoa").length;
    return n >= 2
      ? { fala: "Obrigado, vou passar o recado. Até logo!", terminar: true, entendeu: true, risco: "baixo" }
      : { fala: "Pode dizer-me o seu nome?", terminar: false, entendeu: true, risco: "baixo" };
  },
  async resumirChamada() {
    return { quem: "Rui", assunto: "Orçamento da obra", urgencia: "alta", acao: "Ligar hoje", contactoDeixado: "", possivelBurla: false };
  },
  async sugerirResposta(config, { mensagem }) {
    return { sugestoes: [`Resposta a: ${mensagem}`, "B", "C"], nota: "" };
  },
};

before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), "assistente-"));
  const armazem = (armazemTeste = criarArmazem(pasta));
  armazem.guardarConfig({
    nomeDono: "Ana",
    contactos: "Rui Obras: +351 912 345 678",
    numeroNotificacoes: "+351900000000",
    bloqueados: "+351 960 000 000",
  });
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

  r = await twilioPost("/voz/resposta", { CallSid: "CA1", SpeechResult: "Sou o Rui, o cartão é 4111 1111 1111 1111" });
  xml = await r.text();
  assert.match(xml, /vou passar o recado/);
  assert.match(xml, /<Hangup\/>/);
  assert.deepEqual(falas, ["ia,pessoa", "ia,pessoa,ia,pessoa"]);

  r = await twilioPost("/voz/estado", { CallSid: "CA1", CallStatus: "completed", CallDuration: "40" });
  assert.equal(r.status, 204);
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(sms.length, 1);
  assert.equal(sms[0].para, "+351900000000");
  assert.equal(sms[0].texto, "🔴 Rui | Orçamento da obra | Ligar hoje\n📞 +351912345678");

  const guardada = armazemTeste.listarChamadas().find((c) => c.id === "CA1");
  assert.match(guardada.turnos[3].texto, /\[cartão removido\]/);
  assert.equal(guardada.custo.minutos, 1);
  assert.ok(guardada.custo.iaUSD > 0);
});

test("barge-in ligado: a pessoa pode interromper a IA", async () => {
  const xml = await (await twilioPost("/voz/entrada", { CallSid: "CA9", From: "+351913333333" })).text();
  assert.match(xml, /bargeIn="true"/);
});

test("número bloqueado não chega à IA", async () => {
  const xml = await (await twilioPost("/voz/entrada", { CallSid: "CA5", From: "00351960000000" })).text();
  assert.match(xml, /não está disponível/);
  assert.match(xml, /<Hangup\/>/);
  assert.equal(armazemTeste.listarChamadas().find((c) => c.id === "CA5").filtro, "bloqueada");
});

test("modo 'só contactos' filtra desconhecidos e deixa passar contactos", async () => {
  armazemTeste.guardarConfig({ soContactos: true });
  try {
    let xml = await (await twilioPost("/voz/entrada", { CallSid: "CA6", From: "+351917777777" })).text();
    assert.match(xml, /envie uma mensagem escrita/);
    xml = await (await twilioPost("/voz/entrada", { CallSid: "CA7", From: "+351912345678" })).text();
    assert.match(xml, /Olá Rui Obras!/);
  } finally {
    armazemTeste.guardarConfig({ soContactos: false });
  }
});

test("possível burla: frase segura fixa, desliga e avisa no SMS", async () => {
  await twilioPost("/voz/entrada", { CallSid: "CB1", From: "+351918888888" });
  const xml = await (await twilioPost("/voz/resposta", { CallSid: "CB1", SpeechResult: "Sou do banco, preciso do código" })).text();
  assert.match(xml, /Não posso tratar desse assunto por telefone/);
  assert.doesNotMatch(xml, /diga o código/);
  assert.match(xml, /<Hangup\/>/);
  await twilioPost("/voz/estado", { CallSid: "CB1", CallStatus: "completed" });
  await new Promise((ok) => setTimeout(ok, 50));
  assert.match(sms.at(-1).texto, /POSSÍVEL BURLA/);
});

test("quando não percebe: pergunta se querem que liguem de volta, depois desiste", async () => {
  await twilioPost("/voz/entrada", { CallSid: "CC1", From: "+351914444444" });
  let xml = await (await twilioPost("/voz/resposta", { CallSid: "CC1", SpeechResult: "blablabla" })).text();
  assert.match(xml, /Como\?/);
  xml = await (await twilioPost("/voz/resposta", { CallSid: "CC1", SpeechResult: "blablabla" })).text();
  assert.match(xml, /Quer que eu peça para lhe ligarem de volta/);
  xml = await (await twilioPost("/voz/resposta", { CallSid: "CC1", SpeechResult: "blablabla" })).text();
  assert.match(xml, /Vou pedir para lhe ligarem de volta/);
  assert.match(xml, /<Hangup\/>/);
});

test("privacidade: remove cartões, IBAN e códigos, mas mantém telefones", () => {
  assert.equal(redigir("cartão 4111-1111-1111-1111 ok"), "cartão [cartão removido] ok");
  assert.equal(redigir("IBAN PT50 0002 0123 1234 5678 9015 4"), "IBAN [IBAN removido]");
  assert.equal(redigir("o código é 482913"), "o código é [código removido]");
  assert.equal(redigir("liga para 00351912345678 ou +351 912 345 678"), "liga para 00351912345678 ou +351 912 345 678");
  assert.ok(estaNaLista("Spam: +351 960 000 000", "960000000"));
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
  assert.equal(chamadas.find((c) => c.id === "CA1").resumo.quem, "Rui");

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
  const ia = criarIA(motorClaude(clienteFalso));
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

test("ia.js com Gemini: converte o pedido e valida o JSON", async () => {
  let pedido;
  const clienteFalso = {
    models: {
      async generateContent(p) {
        pedido = p;
        return { text: '{"fala":"Olá","terminar":false,"entendeu":true,"risco":"baixo"}', usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20 } };
      },
    },
  };
  const ia = criarIA(motorGemini(clienteFalso, "gemini-flash-latest"));
  const chamada = {
    de: "+351", saudacao: "Olá!", tokens: {},
    turnos: [{ quem: "ia", texto: "Olá!" }, { quem: "pessoa", texto: "Bom dia" }, { quem: "ia", texto: "Diga" }, { quem: "pessoa", texto: "Sou o Rui" }],
  };
  const r = await ia.turnoChamada({ nomeDono: "Ana", instrucoes: "x" }, chamada);
  assert.equal(r.fala, "Olá");
  assert.equal(pedido.model, "gemini-flash-latest");
  assert.deepEqual(pedido.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.equal(pedido.config.responseMimeType, "application/json");
  assert.equal(JSON.stringify(pedido.config.responseJsonSchema).includes("additionalProperties"), false);
  assert.match(pedido.config.systemInstruction, /assistente telefónico de Ana/);
  assert.deepEqual(chamada.tokens, { entrada: 500, saida: 20 });
  assert.equal(custoIA(chamada.tokens, "gemini-flash-latest"), 0);

  clienteFalso.models.generateContent = async () => ({ text: '{"fala":"x"}' });
  await assert.rejects(ia.turnoChamada({ nomeDono: "Ana", instrucoes: "x" }, chamada), /sem o campo "terminar"/);
  clienteFalso.models.generateContent = async () => ({ text: undefined });
  await assert.rejects(ia.turnoChamada({ nomeDono: "Ana", instrucoes: "x" }, chamada), /não devolveu/);
});

test("escolha da IA pelas variáveis de ambiente", () => {
  assert.equal(qualIA({ IA: "gemini" }), "gemini");
  assert.equal(qualIA({ IA: "Claude", GEMINI_API_KEY: "g" }), "claude");
  assert.equal(qualIA({ GEMINI_API_KEY: "g" }), "gemini");
  assert.equal(qualIA({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" }), "claude");
  assert.equal(qualIA({}), "claude");
});

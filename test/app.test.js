import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TWILIO_VALIDAR = "false";
const { criarApp } = await import("../src/server.js");
const { criarArmazem, nomeDoContacto, estaNaLista } = await import("../src/armazem.js");
const { redigir } = await import("../src/privacidade.js");
const { criarIA, motorClaude, motorGemini, qualIA, custoIA, explicarErro, pensamentoGemini, pcmParaWav } = await import("../src/ia.js");
const RESPOSTA_VAZIA = { resposta: "", tarefas: [], lembrar: [], esquecer: [], pesquisar: "" };

let servidor, base, pasta, armazemTeste;
const sms = [];
const falas = [];
let ultimaConversa;

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
  async sugerirResposta(config, { mensagem, imagem }) {
    return { sugestoes: [`Resposta a: ${mensagem}${imagem ? " +imagem" : ""}`, "B", "C"], nota: "" };
  },
  async falar(texto, voz) {
    return Buffer.from(`WAV:${voz}:${texto}`);
  },
  async carregarFicheiro(dados, mime, nome) {
    return { uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123", mime, nome: `${nome}:${dados.length}` };
  },
  async conversar(config, { historico, imagem, ficheiro, memorias }) {
    ultimaConversa = { historico, imagem, ficheiro, memorias };
    const ultima = historico.at(-1).texto;
    if (/lembra-te/.test(ultima)) {
      return { resposta: "Fica guardado.", tarefas: [], lembrar: ["O médico é o Dr. Silva", "Cartão 4111 1111 1111 1111"], esquecer: [], fontes: [] };
    }
    if (/esquece/.test(ultima)) {
      return { resposta: "Esquecido.", tarefas: [], lembrar: [], esquecer: memorias.map((m) => m.id), fontes: [] };
    }
    return { resposta: "Combinado!", tarefas: [{ titulo: "Pagar a luz", quando: "2026-11-22T09:00:00Z", notas: "" }], lembrar: [], esquecer: [] };
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

test("erros da IA são explicados em português, sem segredos", () => {
  const g = { nome: "gemini", modelo: "gemini-flash-latest" };
  const comStatus = (status, message) => Object.assign(new Error(message), { status });
  assert.match(explicarErro(comStatus(400, "API key not valid. Please pass a valid API key."), g), /GEMINI_API_KEY/);
  assert.match(explicarErro(comStatus(404, "models/x is not found"), g), /GEMINI_MODEL/);
  assert.match(explicarErro(comStatus(429, "Resource has been exhausted"), g), /Espera um minuto/);
  assert.match(explicarErro(comStatus(429, "Quota exceeded for GenerateRequestsPerDayPerProjectPerModel-FreeTier"), g), /quota de hoje/);
  assert.match(explicarErro(Object.assign(new Error("x"), { name: "TimeoutError" }), g), /demorou/);
  assert.match(explicarErro(comStatus(401, "invalid x-api-key"), { nome: "claude" }), /ANTHROPIC_API_KEY/);
});

test("Gemini: se o modelo não existir, escolhe sozinho um Flash disponível", async () => {
  const usados = [];
  const clienteFalso = {
    models: {
      async generateContent(p) {
        usados.push(p.model);
        if (p.model === "gemini-flash-latest") throw Object.assign(new Error("models/gemini-flash-latest is not found"), { status: 404 });
        return { text: '{"sugestoes":["a","b","c"],"nota":""}' };
      },
      async list() {
        return (async function* () {
          yield { name: "models/gemini-2.0-flash", supportedActions: ["generateContent"] };
          yield { name: "models/gemini-2.5-flash-lite", supportedActions: ["generateContent"] };
          yield { name: "models/gemini-2.5-flash", supportedActions: ["generateContent"] };
          yield { name: "models/text-embedding-004", supportedActions: ["embedContent"] };
        })();
      },
    },
  };
  const ia = criarIA(motorGemini(clienteFalso, "gemini-flash-latest"));
  const r = await ia.sugerirResposta({ nomeDono: "Ana", instrucoes: "x", estiloMensagens: "x" }, { mensagem: "Olá" });
  assert.equal(r.sugestoes.length, 3);
  assert.deepEqual(usados, ["gemini-flash-latest", "gemini-2.5-flash"]);
  assert.equal(ia.modelo, "gemini-2.5-flash");
});

test("Gemini ocupado: repete e, se continuar, muda de modelo", async () => {
  const usados = [];
  const clienteFalso = {
    models: {
      async generateContent(p) {
        usados.push(p.model);
        if (p.model === "gemini-2.5-flash") throw Object.assign(new Error("The model is overloaded"), { status: 503 });
        return { text: '{"sugestoes":["a","b","c"],"nota":""}' };
      },
      async list() {
        return (async function* () {
          yield { name: "models/gemini-2.5-flash", supportedActions: ["generateContent"] };
          yield { name: "models/gemini-2.0-flash", supportedActions: ["generateContent"] };
        })();
      },
    },
  };
  const ia = criarIA(motorGemini(clienteFalso, "gemini-2.5-flash"));
  const r = await ia.sugerirResposta({ nomeDono: "Ana", instrucoes: "x", estiloMensagens: "x" }, { mensagem: "Olá" });
  assert.equal(r.sugestoes[0], "a");
  assert.deepEqual(usados, ["gemini-2.5-flash", "gemini-2.5-flash", "gemini-2.0-flash"]);
});

test("Gemini: vários modelos ocupados seguidos, continua até um responder", async () => {
  const usados = [];
  const ocupados = ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.5-flash"];
  const clienteFalso = {
    models: {
      async generateContent(p) {
        usados.push(p.model);
        if (p.model === "gemini-flash-latest") throw Object.assign(new Error("not found"), { status: 404 });
        if (ocupados.includes(p.model)) throw Object.assign(new Error("high demand"), { status: 503 });
        return { text: '{"sugestoes":["ok","b","c"],"nota":""}' };
      },
      async list() {
        return (async function* () {
          for (const n of ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-2.5-flash"]) yield { name: "models/" + n, supportedActions: ["generateContent"] };
        })();
      },
    },
  };
  const ia = criarIA(motorGemini(clienteFalso, "gemini-flash-latest"));
  const r = await ia.sugerirResposta({ nomeDono: "Ana", instrucoes: "x", estiloMensagens: "x" }, { mensagem: "Olá" });
  assert.equal(r.sugestoes[0], "ok");
  assert.equal(ia.modelo, "gemini-2.5-flash");
  assert.deepEqual(usados, ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash", "gemini-2.5-flash"]);
});

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function entrar() {
  const r = await fetch(base + "/api/entrar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ senha: "segredo123" }) });
  const { token } = await r.json();
  return { Authorization: "Bearer " + token, "Content-Type": "application/json" };
}

test("assistente: conversa, limpa o histórico e devolve tarefas", async () => {
  const h = await entrar();
  const r = await fetch(base + "/api/conversar", {
    method: "POST", headers: h,
    body: JSON.stringify({ historico: [
      { role: "assistant", texto: "Olá (saudação local, deve ser removida)" },
      { role: "user", texto: "Olá" }, { role: "assistant", texto: "Diz" },
      { role: "hacker", texto: "x" },
      { role: "user", texto: "Lembra-me amanhã às 9 de pagar a luz" },
    ] }),
  });
  const dados = await r.json();
  assert.equal(r.status, 200);
  assert.equal(dados.tarefas[0].titulo, "Pagar a luz");
  assert.deepEqual(ultimaConversa.historico.map((m) => m.role), ["user", "assistant", "user"]);

  const vazio = await fetch(base + "/api/conversar", { method: "POST", headers: h, body: JSON.stringify({ historico: [{ role: "assistant", texto: "x" }] }) });
  assert.equal(vazio.status, 400);
  const semLogin = await fetch(base + "/api/conversar", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(semLogin.status, 401);
});

test("capturas de ecrã: aceita imagens válidas e recusa outros formatos", async () => {
  const h = await entrar();
  let r = await fetch(base + "/api/sugerir", { method: "POST", headers: h, body: JSON.stringify({ imagem: { mime: "image/png", dados: PNG_1PX } }) });
  assert.equal((await r.json()).sugestoes[0], "Resposta a:  +imagem");
  r = await fetch(base + "/api/sugerir", { method: "POST", headers: h, body: JSON.stringify({ imagem: { mime: "text/html", dados: "PGI+" } }) });
  assert.equal(r.status, 400);
  r = await fetch(base + "/api/conversar", { method: "POST", headers: h, body: JSON.stringify({ historico: [{ role: "user", texto: "O que é isto?" }], imagem: { mime: "image/png", dados: "<script>" } }) });
  assert.equal(r.status, 400);
});

test("imagens chegam no formato certo ao Claude e ao Gemini", async () => {
  let pedidoClaude, pedidoGemini;
  const claude = { beta: { messages: { async create(p) {
    pedidoClaude = p;
    return { stop_reason: "end_turn", content: [{ type: "text", text: '{"resposta":"É um gato","tarefas":[],"lembrar":[],"esquecer":[],"pesquisar":""}' }] };
  } } } };
  const gemini = { models: { async generateContent(p) {
    pedidoGemini = p;
    return { text: '{"resposta":"É um gato","tarefas":[],"lembrar":[],"esquecer":[],"pesquisar":""}' };
  } } };
  const pedido = { historico: [{ role: "user", texto: "O que é isto?" }], imagem: { mime: "image/png", dados: PNG_1PX }, agora: new Date("2026-11-21T12:00:00Z") };
  const config = { nomeDono: "Ana", instrucoes: "x" };

  assert.equal((await criarIA(motorClaude(claude)).conversar(config, pedido)).resposta, "É um gato");
  assert.deepEqual(pedidoClaude.messages[0].content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1PX } });
  assert.deepEqual(pedidoClaude.messages[0].content[1], { type: "text", text: "O que é isto?" });
  assert.match(pedidoClaude.system, /2026/);
  assert.match(pedidoClaude.system, /És Íris/);

  await criarIA(motorGemini(gemini, "gemini-2.5-flash")).conversar(config, pedido);
  assert.deepEqual(pedidoGemini.contents[0].parts, [{ inlineData: { mimeType: "image/png", data: PNG_1PX } }, { text: "O que é isto?" }]);
});

test("Gemini responde depressa: pouco pensamento, e tira-o se o modelo não aceitar", async () => {
  assert.deepEqual(pensamentoGemini("gemini-2.5-flash", "low"), { thinkingBudget: 0 });
  assert.deepEqual(pensamentoGemini("gemini-3.8-flash", "low"), { thinkingLevel: "MINIMAL" });
  assert.deepEqual(pensamentoGemini("gemini-3.8-flash", "medium"), { thinkingLevel: "LOW" });

  const configs = [];
  const clienteFalso = { models: { async generateContent(p) {
    configs.push(p.config.thinkingConfig);
    if (p.config.thinkingConfig) throw Object.assign(new Error("thinking_level is not supported"), { status: 400 });
    return { text: '{"resposta":"Olá","tarefas":[],"lembrar":[],"esquecer":[],"pesquisar":""}' };
  } } };
  const ia = criarIA(motorGemini(clienteFalso, "gemini-3.8-flash"));
  const r = await ia.conversar({ nomeDono: "Ana", instrucoes: "x" }, { historico: [{ role: "user", texto: "Olá" }] });
  assert.equal(r.resposta, "Olá");
  assert.deepEqual(configs, [{ thinkingLevel: "MINIMAL" }, undefined]);
});

test("voz natural: devolve áudio WAV", async () => {
  const h = await entrar();
  const r = await fetch(base + "/api/voz", { method: "POST", headers: h, body: JSON.stringify({ texto: "Olá", voz: "Kore" }) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/wav");
  assert.equal(await r.text(), "WAV:Kore:Olá");
  const semLogin = await fetch(base + "/api/voz", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(semLogin.status, 401);
});

test("Gemini TTS: escolhe o modelo de voz e junta o cabeçalho WAV", async () => {
  let pedido;
  const pcm = Buffer.alloc(480);
  const clienteFalso = { models: {
    async list() { return (async function* () {
      yield { name: "models/gemini-2.5-flash" };
      yield { name: "models/gemini-2.5-pro-preview-tts" };
      yield { name: "models/gemini-2.5-flash-preview-tts" };
    })(); },
    async generateContent(p) {
      pedido = p;
      return { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm.toString("base64") } }] } }] };
    },
  } };
  const ia = criarIA(motorGemini(clienteFalso, "gemini-2.5-flash"));
  const wav = await ia.falar("Bom dia", "Charon");
  assert.equal(pedido.model, "gemini-2.5-flash-preview-tts");
  assert.deepEqual(pedido.config.responseModalities, ["AUDIO"]);
  assert.equal(pedido.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Charon");
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.length, 44 + 480);
  assert.equal(criarIA(motorClaude({})).falar, null);
  assert.equal(pcmParaWav(Buffer.alloc(2)).subarray(8, 12).toString(), "WAVE");
});

test("calendário: as tarefas do telemóvel ficam num link .ics secreto", async () => {
  const h = await entrar();
  let r = await fetch(base + "/api/tarefas", { method: "PUT", headers: h, body: JSON.stringify({ tarefas: [
    { id: 1, titulo: "Pagar a luz", quando: "2026-11-22T09:00:00Z", notas: "EDP", feita: false },
    { id: 2, titulo: "Já feita", quando: "2026-11-22T10:00:00Z", feita: true },
    { id: 3, titulo: "Sem data", quando: "" },
    { id: 4, titulo: "", quando: "2026-11-22T10:00:00Z" },
  ] }) });
  assert.equal((await r.json()).total, 3);

  const { url } = await (await fetch(base + "/api/calendario-link", { headers: h })).json();
  const caminho = new URL(url).pathname;
  assert.match(caminho, /^\/calendario\/[0-9a-f]{32}\.ics$/);
  r = await fetch(base + caminho);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/calendar/);
  const ics = await r.text();
  assert.match(ics, /SUMMARY:Pagar a luz/);
  assert.match(ics, /DTSTART:20261122T090000Z/);
  assert.match(ics, /BEGIN:VALARM/);
  assert.doesNotMatch(ics, /Já feita|Sem data/);

  assert.equal((await fetch(base + "/calendario/00000000000000000000000000000000.ics")).status, 404);

  // Uma só tarefa (botão 📅): o Safari mostra "Adicionar ao calendário".
  r = await fetch(base + caminho.replace(/\.ics$/, "/tarefa.ics") + "?id=1");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /inline/);
  const uma = await r.text();
  assert.match(uma, /SUMMARY:Pagar a luz/);
  assert.equal((uma.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.equal((await fetch(base + caminho.replace(/\.ics$/, "/tarefa.ics") + "?id=999")).status, 404);
});

test("Gemini sem quota: muda logo para outro modelo (cada um tem a sua quota grátis)", async () => {
  const usados = [];
  const semQuota = ["gemini-2.5-flash", "gemini-2.0-flash"];
  const clienteFalso = { models: {
    async generateContent(p) {
      usados.push(p.model);
      if (semQuota.includes(p.model)) throw Object.assign(new Error("Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel-FreeTier"), { status: 429 });
      return { text: '{"resposta":"Já está","tarefas":[],"lembrar":[],"esquecer":[],"pesquisar":""}' };
    },
    async list() { return (async function* () {
      for (const n of ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash-preview-tts"]) yield { name: "models/" + n };
    })(); },
  } };
  const ia = criarIA(motorGemini(clienteFalso, "gemini-2.5-flash"));
  const r = await ia.conversar({ nomeDono: "Ana", instrucoes: "x" }, { historico: [{ role: "user", texto: "Olá" }] });
  assert.equal(r.resposta, "Já está");
  assert.deepEqual(usados, ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"]);
});

test("memória: aprende nas conversas (sem dados sensíveis), lista, apaga e esquece", async () => {
  const h = await entrar();
  const conversar = (texto) => fetch(base + "/api/conversar", { method: "POST", headers: h, body: JSON.stringify({ historico: [{ role: "user", texto }] }) }).then((r) => r.json());

  let r = await conversar("lembra-te que o meu médico é o Dr. Silva");
  assert.deepEqual(r.memoriasNovas, ["O médico é o Dr. Silva", "Cartão [cartão removido]"]);
  r = await conversar("lembra-te outra vez");
  assert.deepEqual(r.memoriasNovas, [], "não repete memórias");

  let mems = await (await fetch(base + "/api/memorias", { headers: h })).json();
  assert.equal(mems.length, 2);
  await conversar("olá");
  assert.deepEqual(ultimaConversa.memorias.map((m) => m.texto), mems.map((m) => m.texto), "a IA recebe a memória");

  await fetch(base + "/api/memorias/" + mems[1].id, { method: "DELETE", headers: h });
  await fetch(base + "/api/memorias", { method: "POST", headers: h, body: JSON.stringify({ texto: "Sou alérgico a marisco" }) });
  mems = await (await fetch(base + "/api/memorias", { headers: h })).json();
  assert.deepEqual(mems.map((m) => m.texto), ["O médico é o Dr. Silva", "Sou alérgico a marisco"]);

  r = await conversar("esquece tudo");
  assert.equal(r.memoriasEsquecidas, 2);
  assert.deepEqual(await (await fetch(base + "/api/memorias", { headers: h })).json(), []);
});

test("ficheiros: envia para o Gemini e a conversa recebe a referência", async () => {
  const h = await entrar();
  let r = await fetch(base + "/api/ficheiros", {
    method: "POST",
    headers: { Authorization: h.Authorization, "Content-Type": "audio/mp4", "X-Nome-Ficheiro": encodeURIComponent("nota de voz.m4a") },
    body: Buffer.alloc(1234),
  });
  const ficheiro = await r.json();
  assert.equal(ficheiro.nome, "nota de voz.m4a:1234");
  assert.equal(ficheiro.mime, "audio/mp4");

  r = await fetch(base + "/api/conversar", { method: "POST", headers: h, body: JSON.stringify({ historico: [{ role: "user", texto: "Resume" }], ficheiro }) });
  assert.equal(r.status, 200);
  assert.equal(ultimaConversa.ficheiro.uri, ficheiro.uri);

  r = await fetch(base + "/api/conversar", { method: "POST", headers: h, body: JSON.stringify({ historico: [{ role: "user", texto: "x" }], ficheiro: { uri: "https://evil.example/x", mime: "audio/mp4" } }) });
  assert.equal(r.status, 400, "só aceita ficheiros da Google");
  r = await fetch(base + "/api/ficheiros", { method: "POST", headers: { Authorization: h.Authorization, "Content-Type": "audio/mp4" }, body: Buffer.alloc(0) });
  assert.equal(r.status, 400);
});

test("Gemini: ficheiros vão como fileData, vídeos esperam pelo processamento", async () => {
  let pedido, estados = ["PROCESSING", "ACTIVE"];
  const cliente = {
    files: {
      async upload({ file, config }) { assert.equal(file.size, 10); return { name: "files/v1", uri: "https://generativelanguage.googleapis.com/v1beta/files/v1", mimeType: config.mimeType, state: "PROCESSING" }; },
      async get() { return { name: "files/v1", uri: "https://generativelanguage.googleapis.com/v1beta/files/v1", mimeType: "video/mp4", state: estados.shift() }; },
    },
    models: { async generateContent(p) { pedido = p; return { text: JSON.stringify({ ...RESPOSTA_VAZIA, resposta: "É um vídeo de um gato" }) }; } },
  };
  const ia = criarIA(motorGemini(cliente, "gemini-2.5-flash"));
  const f = await ia.carregarFicheiro(Buffer.alloc(10), "video/mp4", "gato.mp4");
  assert.equal(f.uri, "https://generativelanguage.googleapis.com/v1beta/files/v1");
  const r = await ia.conversar({ nomeDono: "Ana", instrucoes: "x" }, { historico: [{ role: "user", texto: "O que é?" }], ficheiro: f });
  assert.equal(r.resposta, "É um vídeo de um gato");
  assert.deepEqual(pedido.contents[0].parts[0], { fileData: { fileUri: f.uri, mimeType: "video/mp4" } });

  // O Claude não aceita estes ficheiros: erro claro.
  const claude = criarIA(motorClaude({ beta: { messages: { create: async () => ({}) } } }));
  await assert.rejects(claude.conversar({ nomeDono: "Ana", instrucoes: "x" }, { historico: [{ role: "user", texto: "x" }], ficheiro: f }), /só funcionam com o Gemini/);
  assert.equal(claude.carregarFicheiro, null);
});

test("pesquisa na internet: quando a IA pede, pesquisa e devolve fontes", async () => {
  const pedidos = [];
  const cliente = { models: { async generateContent(p) {
    pedidos.push(p);
    if (p.config.tools) {
      return { text: "O Benfica ganhou 2-1.", candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: "https://exemplo.pt/jogo", title: "exemplo.pt" } }] } }] };
    }
    return { text: JSON.stringify({ ...RESPOSTA_VAZIA, resposta: "Vou ver.", pesquisar: "resultado Benfica ontem" }) };
  } } };
  const ia = criarIA(motorGemini(cliente, "gemini-2.5-flash"));
  const r = await ia.conversar({ nomeDono: "Ana", instrucoes: "x" }, { historico: [{ role: "user", texto: "Quanto ficou o Benfica?" }] });
  assert.equal(r.resposta, "O Benfica ganhou 2-1.");
  assert.deepEqual(r.fontes, [{ url: "https://exemplo.pt/jogo", titulo: "exemplo.pt" }]);
  assert.deepEqual(pedidos[1].config.tools, [{ googleSearch: {} }]);
  assert.match(pedidos[1].contents.at(-1).parts[0].text, /resultado Benfica ontem/);

  // Claude: usa a ferramenta web_search e lê as citações.
  let pedidoClaude;
  const claude = criarIA(motorClaude({ beta: { messages: { async create(p) {
    if (!p.tools) return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ ...RESPOSTA_VAZIA, resposta: "Vou ver.", pesquisar: "tempo Lisboa amanhã" }) }] };
    pedidoClaude = p;
    return { stop_reason: "end_turn", content: [{ type: "text", text: "Amanhã chove.", citations: [{ url: "https://ipma.pt", title: "IPMA" }] }] };
  } } } }));
  const rc = await claude.conversar({ nomeDono: "Ana", instrucoes: "x" }, { historico: [{ role: "user", texto: "Vai chover?" }] });
  assert.equal(rc.resposta, "Amanhã chove.");
  assert.deepEqual(rc.fontes, [{ url: "https://ipma.pt", titulo: "IPMA" }]);
  assert.equal(pedidoClaude.tools[0].type, "web_search_20260209");
});

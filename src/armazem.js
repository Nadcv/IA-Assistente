// Guarda configuração e histórico de chamadas em ficheiros JSON (pasta data/).
import fs from "node:fs";
import path from "node:path";

export const CONFIG_PADRAO = {
  ativo: true,
  nomeDono: "", // o teu nome, ex.: "Nadio"
  // O que a IA pode dizer sobre ti / a tua disponibilidade. Edita no painel.
  instrucoes:
    "Estou ocupado e não posso atender. Volto a ligar assim que puder. " +
    "Para assuntos urgentes, anota o nome, o motivo e o número de contacto.",
  // Uma linha por contacto: "Nome: +351912345678"
  contactos: "",
  // Números que nunca são atendidos pela IA (spam), um por linha.
  bloqueados: "",
  // true: a IA só atende quem está nos contactos; os outros ouvem um aviso curto.
  soContactos: false,
  // Apaga chamadas guardadas há mais de X dias (privacidade).
  diasRetencao: 30,
  // Para onde enviar o resumo de cada chamada (o teu telemóvel).
  numeroNotificacoes: "",
  // Estilo das sugestões de resposta para mensagens.
  estiloMensagens: "Informal, simpático, frases curtas, português de Portugal.",
};

export function criarArmazem(pasta = process.env.DATA_DIR || "data") {
  fs.mkdirSync(pasta, { recursive: true });
  const ficheiroConfig = path.join(pasta, "config.json");
  const ficheiroChamadas = path.join(pasta, "chamadas.json");

  const ler = (f, padrao) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return padrao;
    }
  };
  const escrever = (f, dados) => {
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(dados, null, 2));
    fs.renameSync(tmp, f);
  };

  return {
    lerConfig() {
      return { ...CONFIG_PADRAO, ...ler(ficheiroConfig, {}) };
    },
    guardarConfig(parcial) {
      const permitidos = Object.keys(CONFIG_PADRAO);
      const atual = this.lerConfig();
      for (const k of permitidos) {
        if (k in parcial) {
          const padrao = CONFIG_PADRAO[k];
          if (typeof padrao === "boolean") atual[k] = Boolean(parcial[k]);
          else if (typeof padrao === "number") atual[k] = Math.min(365, Math.max(1, Math.round(Number(parcial[k]) || padrao)));
          else atual[k] = String(parcial[k]).slice(0, 5000);
        }
      }
      escrever(ficheiroConfig, atual);
      return atual;
    },
    listarChamadas() {
      return this._recentes();
    },
    // Só as chamadas dentro do prazo de retenção.
    _recentes() {
      const limite = Date.now() - this.lerConfig().diasRetencao * 86_400_000;
      return ler(ficheiroChamadas, []).filter((c) => Date.parse(c.inicio) >= limite);
    },
    guardarChamada(chamada) {
      const todas = this._recentes().filter((c) => c.id !== chamada.id);
      todas.unshift(chamada);
      escrever(ficheiroChamadas, todas.slice(0, 500));
    },
  };
}

const limparNumero = (n) => String(n || "").replace(/[^\d+]/g, "").replace(/^00/, "+");

// true se o número estiver na lista (um número por linha; aceita "Nome: número").
export function estaNaLista(listaTexto, numero) {
  const alvo = limparNumero(numero);
  if (alvo.length < 9) return false;
  return String(listaTexto || "").split("\n").some((linha) => {
    const num = limparNumero(linha.slice(linha.lastIndexOf(":") + 1));
    return num.length >= 9 && num.slice(-9) === alvo.slice(-9);
  });
}

// Converte o texto "Nome: +351..." numa lista e procura quem está a ligar.
export function nomeDoContacto(contactosTexto, numero) {
  const limpar = limparNumero;
  const alvo = limpar(numero);
  if (!alvo) return null;
  for (const linha of String(contactosTexto || "").split("\n")) {
    const i = linha.lastIndexOf(":");
    if (i < 0) continue;
    const nome = linha.slice(0, i).trim();
    const num = limpar(linha.slice(i + 1));
    if (!nome || num.length < 9) continue;
    // Compara os últimos 9 dígitos, para "+351912..." e "912..." darem match.
    if (num === alvo || num.slice(-9) === alvo.slice(-9)) return nome;
  }
  return null;
}

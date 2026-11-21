# 🤖 Assistente IA

Assistente pessoal com inteligência artificial (Gemini grátis ou Claude):

- **🤖 Assistente por voz ou texto.** Perguntas, pedes para escrever uma
  mensagem ou um email, planear o dia... Carregas em 🎤 para falar e ele pode
  ler as respostas em voz alta. Também percebe imagens (📷).
- **✅ Tarefas e lembretes.** Dizes "lembra-me amanhã às 9 de pagar a luz" e
  a tarefa é criada. O botão 📅 põe-na no calendário do telemóvel, com alerta.
  As tarefas e a conversa ficam guardadas no próprio telemóvel.
- **📞 Atende chamadas quando não podes.** Quem te liga e não é atendido é
  reencaminhado para a IA, que conversa por voz em português de Portugal,
  percebe quem é e o que quer, e anota o recado. No fim recebes um **SMS com o
  resumo** (quem, assunto, urgência, o que fazer).
- **💬 Ajuda a responder mensagens** do Instagram, Facebook, WhatsApp, etc.
  Tiras uma **captura de ecrã** da conversa (ou colas o texto, ou usas
  **Partilhar → Assistente** no Android) e recebes
  3 respostas no teu estilo, prontas a copiar. Também avisa se a mensagem
  parecer burla.
- **⚙️ Painel web** (instalável no telemóvel como app): histórico das chamadas
  com a conversa completa, ligar/desligar a IA, o que a IA pode dizer, lista de
  contactos conhecidos.

## Porque é que as mensagens não são respondidas sozinhas?

A Meta só permite respostas automáticas em **contas Profissionais** (Instagram
Business/Criador e Páginas do Facebook), através da API oficial. Automatizar
uma conta **pessoal** (robôs que fazem login por ti) viola os termos e leva a
bloqueios da conta. Por isso, nas contas pessoais, a IA **sugere** e és tu que
envias, com um toque.

> Se mudares para conta Profissional (é grátis: Definições → Tipo de conta),
> dá para acrescentar respostas 100% automáticas pela API oficial da Meta.

## Triagem e proteção nas chamadas

- **Interromper a IA (barge-in):** se a pessoa começar a falar, a IA cala-se e
  ouve, como numa conversa normal.
- **Filtro antes de atender:** números bloqueados ouvem um aviso curto e a
  chamada desliga sem gastar IA. Há também o modo **"só contactos"**, em que a
  IA só atende quem está na tua lista. No painel, cada chamada tem um botão
  **Bloquear número**.
- **Deteção de burla na chamada:** se alguém pedir códigos, dados bancários ou
  pagamentos, ou disser que é do banco com pressa, a IA diz uma frase segura
  fixa ("Não posso tratar desse assunto por telefone. Vou desligar.") e desliga.
  O SMS chega com **⚠️ POSSÍVEL BURLA**.
- **Quando não percebe:** à segunda vez que não entende, pergunta se querem que
  te liguem de volta. À terceira despede-se, e a chamada fica marcada como
  "confusa" no painel.
- **SMS curto:** `🔴 Mãe | Consulta mudou para 15h | Ligar antes das 14h`,
  seguido do número.
- **Privacidade:** números de cartão, IBAN e códigos são apagados das conversas
  antes de serem guardadas ou enviadas por SMS. As chamadas são apagadas
  automaticamente ao fim de 30 dias (podes mudar no painel).
- **Custo por chamada:** o painel mostra uma estimativa do custo da IA e os
  minutos de cada chamada.

## Segurança

- A IA ao telefone **nunca** dá dados pessoais, códigos ou palavras-passe,
  nunca assume compromissos nem aceita pagamentos em teu nome — só anota
  recados. Ignora quem tente mudar as regras dela.
- Só partilha o que escreveres no campo "O que a IA pode dizer".
- Os pedidos de chamadas são validados com a assinatura do Twilio (ninguém
  consegue fingir chamadas para gastar os teus créditos).
- Conversas limitadas a 12 trocas; o painel tem limite de tentativas de login.

## Como pôr a funcionar

### 1. Contas necessárias

| Serviço | Para quê | Custo aproximado |
|---|---|---|
| [Google AI Studio](https://aistudio.google.com) | A IA (Gemini) — **opção grátis** | 0 € (limite de pedidos por dia) |
| [Anthropic](https://console.anthropic.com) | A IA (Claude) — opção paga, mais fiável | alguns cêntimos por chamada |
| [Twilio](https://www.twilio.com) | Número de telefone + voz + SMS | número ~1–15 €/mês + cêntimos/minuto |
| [Render](https://render.com) (ou outro) | Servidor sempre ligado | ~7 $/mês |

> Números portugueses (+351) no Twilio exigem um "Regulatory Bundle"
> (documento de identificação e morada), e a aprovação pode demorar alguns
> dias: pede o número antes de quereres testar chamadas reais. Em alternativa podes usar um número de
> outro país, mas o reencaminhamento pode custar mais na tua operadora.

> **Alternativas mais baratas ao Twilio** (operadores SIP portugueses, números
> virtuais gratuitos, assistentes de voz que correm no teu próprio servidor):
> o código atual usa a voz e o reconhecimento de fala do Twilio. Mudar para
> SIP implica tratar do áudio por conta própria (voz para texto e texto para
> voz), por isso fica para uma fase seguinte.

### Gemini (grátis) ou Claude (pago)?

Escolhe com a variável `IA`:

- **`IA=gemini`** (por omissão no Render): grátis, com limite diário de pedidos.
  Uma chamada gasta cerca de 5 a 10 pedidos. Se passares o limite, a IA deixa
  de responder até ao dia seguinte (a chamada diz que houve um problema técnico
  e tu recebes o SMS na mesma). Confirma nos termos da Google se as conversas
  do plano grátis podem ser usadas para treino.
- **`IA=claude`**: pago, mais fiável a detetar burlas e a cumprir as regras de
  segurança. Para gastar menos, junta `CLAUDE_MODEL=claude-haiku-5-5`.

### 2. Instalar o servidor

```bash
npm install
cp .env.example .env   # preenche os valores
node --env-file=.env src/server.js
```

No Render: **New → Blueprint** e escolhe este repositório (usa o `render.yaml`).
Preenche as variáveis pedidas; `PUBLIC_URL` é o endereço que o Render te dá.

### 3. Ligar o número do Twilio

No Twilio → Phone Numbers → o teu número → **Voice Configuration**:

- *A call comes in* → Webhook → `https://O-TEU-SERVIDOR/voz/entrada` (POST)
- *Call status changes* → `https://O-TEU-SERVIDOR/voz/estado` (POST)

### 4. Reencaminhar as chamadas do teu telemóvel

No teu telemóvel, marca estes códigos (funcionam na MEO, NOS e Vodafone; troca
`NUMERO` pelo número Twilio, com `+351…` ou o indicativo do país):

| Quando | Código para ativar | Para desativar |
|---|---|---|
| Não atendes | `**61*NUMERO#` ou, para escolher quantos segundos toca antes (5–30), `**61*NUMERO**20#` | `##61#` |
| Estás ocupado | `**67*NUMERO#` | `##67#` |
| Sem rede / desligado | `**62*NUMERO#` | `##62#` |
| Todas as anteriores | `**004*NUMERO#` | `##004#` |

Os códigos podem variar um pouco entre operadoras: se algum não funcionar,
confirma com a tua (MEO, NOS ou Vodafone) ou usa Definições → Chamadas →
Reencaminhamento no telemóvel.

### 5. Painel e app no telemóvel

Abre `https://O-TEU-SERVIDOR`, entra com a `PAINEL_SENHA`, e em
**Definições** escreve o teu nome, o que a IA pode dizer e o teu telemóvel para
os SMS. No Android, no Chrome: menu → **Instalar app**. A partir daí a app
aparece no menu **Partilhar** do Instagram, Facebook e outras.

## Testes

```bash
npm test
```

Testam uma chamada completa (saudação → conversa → resumo → SMS), silêncio,
validação do Twilio, login do painel e o formato do pedido ao Claude — tudo
com IA e Twilio simulados, sem gastar créditos.

## Estrutura

```
src/server.js     servidor + API do painel
src/voz.js        webhooks do Twilio (atender chamadas)
src/ia.js         conversa, resumos e sugestões com o Claude
src/armazem.js    configuração e histórico (ficheiros JSON em data/)
src/notificar.js  SMS de resumo
public/           painel web (PWA com "Partilhar")
```

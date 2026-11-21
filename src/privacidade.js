// Tira dados sensíveis das transcrições antes de as guardar ou enviar por SMS.
// Mantém números de telefone (são precisos para ligar de volta).

const CARTAO = /\b\d(?:[ -]?\d){12,18}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/gi;
const CODIGO = /\b(c[oó]digo|pin|senha|password|palavra[- ]passe|cvv|otp)(\D{0,20}?)(\d[\d ]{2,9}\d)\b/gi;

export function redigir(texto) {
  return String(texto ?? "")
    .replace(IBAN, (m) => (/\d{8,}/.test(m.replace(/\s/g, "")) ? "[IBAN removido]" : m))
    .replace(CARTAO, (m) => {
      const d = m.replace(/\D/g, "");
      // "00351 912..." é um telefone internacional, não um cartão.
      return d.length >= 13 && !d.startsWith("00") ? "[cartão removido]" : m;
    })
    .replace(CODIGO, (_, palavra, meio) => `${palavra}${meio}[código removido]`);
}

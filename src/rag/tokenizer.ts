const NON_CJK_WORD_OR_NUMBER = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}_$]+/gu;
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function normalizeToken(token: string): string {
  return token.normalize('NFKC').toLowerCase();
}

export function tokenizeRagText(text: string): string[] {
  const normalized = text.normalize('NFKC');
  const tokens = new Set<string>();

  for (const match of normalized.matchAll(NON_CJK_WORD_OR_NUMBER)) {
    const token = normalizeToken(match[0]);
    if (token) {
      tokens.add(token);
      for (const part of token.split(/[_$]+/).filter(Boolean)) {
        tokens.add(part);
      }
    }
  }

  const cjk = Array.from(normalized).filter((character) => CJK_CHARACTER.test(character));
  for (const character of cjk) {
    tokens.add(character);
  }
  for (let index = 0; index + 1 < cjk.length; index += 1) {
    tokens.add(`${cjk[index]}${cjk[index + 1]}`);
  }

  return [...tokens];
}

export function processRagTerm(term: string): string | null {
  const normalized = normalizeToken(term).trim();
  return normalized || null;
}

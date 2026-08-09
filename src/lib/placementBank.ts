// Offline placement-quiz word bank — no AI needed.
// Each entry: the target-language word, optional reading, and its meaning in each UI language.
import type { LearningLangCode } from "./languages";

export type BankWord = {
  word: string;
  reading?: string;
  /** meaning keyed by UI language code */
  m: { en: string; ja: string };
};

type Bank = Record<string, BankWord[]>; // level -> words

const w = (word: string, en: string, ja: string, reading?: string): BankWord => ({ word, reading, m: { en, ja } });

const ja: Bank = {
  N5: [
    w("水", "water", "水", "みず"),
    w("学校", "school", "学校", "がっこう"),
    w("食べる", "to eat", "食べる", "たべる"),
    w("新しい", "new", "新しい", "あたらしい"),
    w("友達", "friend", "友達", "ともだち"),
  ],
  N4: [
    w("急ぐ", "to hurry", "急ぐ", "いそぐ"),
    w("親切", "kind, helpful", "親切な", "しんせつ"),
    w("経験", "experience", "経験", "けいけん"),
    w("直す", "to fix, repair", "直す", "なおす"),
    w("将来", "the future", "将来", "しょうらい"),
  ],
  N3: [
    w("我慢", "endurance, patience", "我慢", "がまん"),
    w("募集", "recruitment", "募集", "ぼしゅう"),
    w("諦める", "to give up", "諦める", "あきらめる"),
    w("普段", "usually, ordinarily", "普段", "ふだん"),
    w("影響", "influence, effect", "影響", "えいきょう"),
  ],
  N2: [
    w("曖昧", "vague, ambiguous", "曖昧な", "あいまい"),
    w("維持", "maintenance, upkeep", "維持", "いじ"),
    w("率直", "frank, candid", "率直な", "そっちょく"),
    w("補う", "to compensate for", "補う", "おぎなう"),
    w("矛盾", "contradiction", "矛盾", "むじゅん"),
  ],
  N1: [
    w("憂鬱", "melancholy, gloom", "憂鬱", "ゆううつ"),
    w("挙句", "in the end, after all", "挙句", "あげく"),
    w("顕著", "remarkable, striking", "顕著な", "けんちょ"),
    w("怠る", "to neglect", "怠る", "おこたる"),
    w("紛らわしい", "confusingly similar", "紛らわしい", "まぎらわしい"),
  ],
};

const de: Bank = {
  A1: [
    w("Haus", "house", "家"),
    w("trinken", "to drink", "飲む"),
    w("morgen", "tomorrow", "明日"),
    w("Freund", "friend", "友達"),
  ],
  A2: [
    w("Bahnhof", "train station", "駅"),
    w("einladen", "to invite", "招待する"),
    w("wichtig", "important", "重要な"),
    w("Rechnung", "bill, invoice", "請求書"),
  ],
  B1: [
    w("Erfahrung", "experience", "経験"),
    w("verbessern", "to improve", "改善する"),
    w("ungefähr", "approximately", "およそ"),
    w("Umgebung", "surroundings", "周辺"),
  ],
  B2: [
    w("Voraussetzung", "prerequisite", "前提条件"),
    w("bewältigen", "to cope with", "克服する"),
    w("nachhaltig", "sustainable", "持続可能な"),
    w("Zusammenhang", "context, connection", "関連"),
  ],
  C1: [
    w("Ausmaß", "extent, scale", "規模"),
    w("erörtern", "to discuss in detail", "詳細に論じる"),
    w("beiläufig", "casual, offhand", "何気ない"),
    w("Vorbehalt", "reservation, proviso", "留保"),
  ],
  C2: [
    w("Gepflogenheit", "custom, practice", "慣習"),
    w("verschmähen", "to spurn, disdain", "拒絶する"),
    w("unabdingbar", "indispensable", "不可欠な"),
    w("Sachverhalt", "state of affairs", "事実関係"),
  ],
};

const es: Bank = {
  A1: [
    w("agua", "water", "水"),
    w("comer", "to eat", "食べる"),
    w("mañana", "tomorrow, morning", "明日、朝"),
    w("amigo", "friend", "友達"),
  ],
  A2: [
    w("estación", "station, season", "駅、季節"),
    w("invitar", "to invite", "招待する"),
    w("importante", "important", "重要な"),
    w("factura", "bill, invoice", "請求書"),
  ],
  B1: [
    w("experiencia", "experience", "経験"),
    w("mejorar", "to improve", "改善する"),
    w("aproximadamente", "approximately", "およそ"),
    w("entorno", "surroundings", "周辺"),
  ],
  B2: [
    w("requisito", "requirement", "要件"),
    w("afrontar", "to face, cope with", "立ち向かう"),
    w("sostenible", "sustainable", "持続可能な"),
    w("vínculo", "link, bond", "つながり"),
  ],
  C1: [
    w("alcance", "scope, reach", "範囲"),
    w("esbozar", "to sketch, outline", "概略を示す"),
    w("soslayar", "to sidestep, avoid", "回避する"),
    w("salvedad", "caveat, proviso", "但し書き"),
  ],
  C2: [
    w("idiosincrasia", "idiosyncrasy", "特異性"),
    w("desdeñar", "to disdain", "軽蔑する"),
    w("imprescindible", "indispensable", "不可欠な"),
    w("acervo", "heritage, body of works", "蓄積、遺産"),
  ],
};

const fr: Bank = {
  A1: [
    w("eau", "water", "水"),
    w("manger", "to eat", "食べる"),
    w("demain", "tomorrow", "明日"),
    w("ami", "friend", "友達"),
  ],
  A2: [
    w("gare", "train station", "駅"),
    w("inviter", "to invite", "招待する"),
    w("important", "important", "重要な"),
    w("facture", "bill, invoice", "請求書"),
  ],
  B1: [
    w("expérience", "experience", "経験"),
    w("améliorer", "to improve", "改善する"),
    w("environ", "approximately", "およそ"),
    w("entourage", "surroundings, circle", "周囲"),
  ],
  B2: [
    w("condition préalable", "prerequisite", "前提条件"),
    w("surmonter", "to overcome", "克服する"),
    w("durable", "sustainable", "持続可能な"),
    w("lien", "link, connection", "つながり"),
  ],
  C1: [
    w("ampleur", "extent, scale", "規模"),
    w("aborder", "to tackle, address", "取り組む"),
    w("anodin", "trivial, harmless", "他愛のない"),
    w("réserve", "reservation, caveat", "留保"),
  ],
  C2: [
    w("us et coutumes", "customs and practices", "慣習"),
    w("dédaigner", "to disdain", "軽蔑する"),
    w("incontournable", "unavoidable, essential", "避けて通れない"),
    w("teneur", "content, substance", "内容"),
  ],
};

export const PLACEMENT_BANK: Record<LearningLangCode, Bank> = { ja, de, es, fr };

export type PlacementQuestion = {
  prompt: string;
  word: string;
  reading: string;
  choices: string[];
  correct_index: number;
  level: string;
  jp_word: string;
  jlpt_level: string;
};

const shuffle = <T,>(arr: T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Build a placement quiz locally — instant, no AI call. */
export const buildPlacementQuiz = (
  learningLanguage: LearningLangCode,
  uiLanguage: string,
  perLevel = 4,
): PlacementQuestion[] => {
  const bank = PLACEMENT_BANK[learningLanguage] ?? PLACEMENT_BANK.ja;
  const ui: "en" | "ja" = uiLanguage === "ja" ? "ja" : "en";
  const promptFor = (word: string) =>
    ui === "ja" ? `「${word}」の意味は？` : `What does "${word}" mean?`;

  const all = Object.values(bank).flat();
  const questions: PlacementQuestion[] = [];

  for (const [level, words] of Object.entries(bank)) {
    for (const entry of shuffle(words).slice(0, perLevel)) {
      const answer = entry.m[ui];
      const distractors = shuffle(all.filter((o) => o.m[ui] !== answer))
        .slice(0, 3)
        .map((o) => o.m[ui]);
      const choices = shuffle([answer, ...distractors]);
      questions.push({
        prompt: promptFor(entry.word),
        word: entry.word,
        reading: entry.reading ?? "",
        choices,
        correct_index: choices.indexOf(answer),
        level,
        jp_word: entry.word,
        jlpt_level: level,
      });
    }
  }
  return questions;
};

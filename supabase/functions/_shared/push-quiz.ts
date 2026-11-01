// Chrome Android exposes at most two notification action buttons.
export function buildNotificationQuiz(meaning: string, meanings: string[], random = Math.random): { options: string[]; correctIndex: number } | null {
  const answer = meaning.trim();
  const distractors = [...new Set(meanings.map(m => m.trim()).filter(m => m && m.toLocaleLowerCase() !== answer.toLocaleLowerCase()))];
  if (!answer || !distractors.length) return null;
  const distractor = distractors[Math.floor(random() * distractors.length)];
  const correctIndex = random() < 0.5 ? 0 : 1;
  return { options: correctIndex === 0 ? [answer, distractor] : [distractor, answer], correctIndex };
}
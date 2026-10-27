import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { notificationRequest } from "@/lib/flashcard-push";

type ReviewCard = { id: string; word: string; reading: string | null; meaning: string | null; example_sentence: string | null; learning_language: string; reviewed_at: string | null };
export default function NotificationReview() {
  const { deliveryId } = useParams();
  const { t } = useI18n();
  const [card, setCard] = useState<ReviewCard | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(false); setRevealed(false); setDone(false);
    notificationRequest<{ card: ReviewCard }>({ action: "card", delivery_id: deliveryId }).then(({ card }) => {
      if (active) { setCard(card); setDone(Boolean(card.reviewed_at)); }
    }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [deliveryId]);
  const grade = async (remembered: boolean) => {
    if (!card) return;
    setBusy(true); setError(false);
    try { await notificationRequest({ action: "review", delivery_id: card.id, remembered }); setDone(true); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  return <main className="max-w-md mx-auto px-5 py-12 text-center">
    <h1 className="text-xl font-semibold mb-8">{t("push.title")}</h1>
    {loading ? <p>{t("common.loading")}</p> : <>
      {error && <p role="alert" className="text-destructive mb-4">{t("push.failed")}</p>}
      {card && <>
        <div lang={card.learning_language} className="min-h-40 grid place-content-center gap-3 break-words"><h2 className="text-4xl font-bold">{card.word}</h2>{card.reading && card.reading !== card.word && <p className="text-muted-foreground">{card.reading}</p>}</div>
        {done ? <p role="status" className="text-primary mt-6">{t("push.reviewed")}</p> : !revealed ? <Button onClick={() => setRevealed(true)} className="mt-6">{t("push.reveal")}</Button> : <>
          <p className="text-xl mt-4 break-words">{card.meaning}</p>
          {card.example_sentence && <p lang={card.learning_language} className="mt-4 text-muted-foreground break-words">{card.example_sentence}</p>}
          <div className="grid grid-cols-2 gap-3 mt-8"><Button variant="outline" disabled={busy} onClick={() => grade(false)}><X className="h-4 w-4" />{t("push.again")}</Button><Button disabled={busy} onClick={() => grade(true)}><Check className="h-4 w-4" />{t("push.remembered")}</Button></div>
        </>}
      </>}
    </>}
  </main>;
}
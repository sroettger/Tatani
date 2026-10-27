import { useEffect, useState } from "react";
import { Bell, BellOff, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/i18n";
import { enableFlashcardPush, notificationRequest, type DeviceSchedule } from "@/lib/flashcard-push";
import { toast } from "sonner";

export function NotificationSettings() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [device, setDevice] = useState<DeviceSchedule | null>(null);
  const [start, setStart] = useState(9);
  const [end, setEnd] = useState(21);
  const [count, setCount] = useState(4);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const key = `tatani-push-device-${user?.id}`;
  useEffect(() => {
    let active = true;
    setDevice(null);
    if (!user) return;
    const id = localStorage.getItem(key);
    if (!id) return;
    notificationRequest<{ device: DeviceSchedule | null }>({ action: "settings", device_id: id }).then(({ device }) => {
      if (!active || !device) return;
      setDevice(device); setStart(device.start_hour); setEnd(device.end_hour); setCount(device.cards_per_day);
    }).catch(() => { if (active) setMessage(t("push.failed")); });
    return () => { active = false; };
  }, [user?.id, key, t]);
  const enable = async () => {
    setBusy(true); setMessage("");
    try {
      const result = await enableFlashcardPush();
      if (result.status !== "registered") {
        const messages = { "not-configured": "push.notConfigured", unsupported: "push.unsupported", "open-in-new-tab": "push.openTab", denied: "push.denied" } as const;
        setMessage(t(messages[result.status])); return;
      }
      const { device } = await notificationRequest<{ device: DeviceSchedule }>({ action: "enable", token: result.token, schedule: { timezone, start_hour: start, end_hour: end, cards_per_day: count } });
      localStorage.setItem(key, device.id); setDevice(device); toast.success(t("push.saved"));
    } catch (error) { setMessage(t("push.failed")); console.error(error); }
    finally { setBusy(false); }
  };
  const run = async (action: "disable" | "test") => {
    if (!device) return;
    setBusy(true); setMessage("");
    try {
      const result = await notificationRequest<{ result?: string }>({ action, device_id: device.id });
      if (action === "disable") { setDevice({ ...device, enabled: false }); toast.success(t("push.off")); }
      else setMessage(t(result.result === "empty" ? "push.empty" : "push.testSent"));
    } catch (error) { setMessage(t("push.failed")); console.error(error); }
    finally { setBusy(false); }
  };
  const valid = end > start && count >= 1 && count <= Math.min(12, end - start + 1);
  return <section className="py-4 border-y border-border">
    <h3 className="font-semibold flex items-center gap-2 mb-3"><Bell className="h-4 w-4" />{t("push.title")}</h3>
    <div className="grid grid-cols-3 gap-3">
      <div><Label htmlFor="push-start">{t("push.start")}</Label><Input id="push-start" type="time" step="3600" value={`${String(start).padStart(2, "0")}:00`} onChange={e => setStart(Number(e.target.value.split(":")[0]))} className="mt-1 px-2" /></div>
      <div><Label htmlFor="push-end">{t("push.end")}</Label><Input id="push-end" type="time" step="3600" value={`${String(end).padStart(2, "0")}:00`} onChange={e => setEnd(Number(e.target.value.split(":")[0]))} className="mt-1 px-2" /></div>
      <div><Label htmlFor="push-count">{t("push.count")}</Label><Input id="push-count" type="number" min={1} max={12} value={count} onChange={e => setCount(Number(e.target.value))} className="mt-1" /></div>
    </div>
    <p className="text-xs text-muted-foreground mt-2">{timezone} · {device?.enabled ? t("push.on") : t("push.off")}</p>
    {!valid && <p className="text-sm text-destructive mt-2">{t("push.invalid")}</p>}
    <div className="flex flex-wrap gap-2 mt-3">
      <Button disabled={busy || !valid} onClick={enable}><Bell className="h-4 w-4" />{t(device?.enabled ? "common.save" : "push.enable")}</Button>
      {device?.enabled && <><Button variant="outline" disabled={busy} onClick={() => run("test")}><Send className="h-4 w-4" />{t("push.test")}</Button><Button variant="ghost" disabled={busy} onClick={() => run("disable")}><BellOff className="h-4 w-4" />{t("push.disable")}</Button></>}
    </div>
    {message && <p role="status" className="text-sm text-muted-foreground mt-3">{message}</p>}
  </section>;
}
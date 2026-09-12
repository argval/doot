import { useEffect, useState } from "react";
import { gatewayFetch } from "../lib/gateway";

export function PrivacySection() {
  const [policy, setPolicy] = useState<{ saveHistory: boolean; retentionDays: number } | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [retention, setRetention] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void gatewayFetch("/v1/history/policy", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("History preferences are unavailable.");
      const next = await response.json() as { saveHistory: boolean; retentionDays: number };
      if (!controller.signal.aborted) { setPolicy(next); setRetention(next.retentionDays); }
    }).catch((error: unknown) => { if (!controller.signal.aborted) setNotice(String(error)); });
    return () => controller.abort();
  }, []);
  async function save(next: { saveHistory: boolean; retentionDays: number }) {
    setBusy(true); setNotice("");
    try {
      const response = await gatewayFetch("/v1/history/policy", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      if (!response.ok) throw new Error("Could not save history preferences.");
      setPolicy(next); setNotice("Preferences saved. Recording changes apply to the next caption session.");
    } catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  }
  return <>
    <p className="settings-intro">Audio is sent to the speech provider selected for your languages. Text may also be sent to a translation provider. Doot does not save raw audio. When history is enabled, source and translated captions are stored on this computer, without application-level encryption.</p>
    <section className="settings-group" aria-label="History privacy">
      <label className="settings-row"><span><strong>Save caption history</strong><em>Applies to new sessions. Turning this off does not delete existing history.</em></span><input type="checkbox" role="switch" disabled={!policy || busy} checked={policy?.saveHistory ?? false} onChange={(event) => { if (policy) void save({ ...policy, saveHistory: event.target.checked }); }} /></label>
      <label className="settings-row"><span><strong>Keep history</strong><em>Only finished sessions are removed. Active sessions are kept.</em></span><select value={retention} disabled={!policy || busy} onChange={(event) => setRetention(Number(event.target.value))}><option value={0}>Until I delete it</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label>
    </section>
    {policy && retention !== policy.retentionDays && <div className="settings-history-actions"><button disabled={busy} onClick={() => void save({ ...policy, retentionDays: retention })}>{retention ? `Delete history older than ${retention} days and apply` : "Keep history until I delete it"}</button></div>}
    <p className="settings-footnote">Retention deletion is permanent. Individual sessions can be exported or deleted from History. Provider data handling is governed by your provider account terms.</p>
    {notice && <p className="settings-footnote" role="status">{notice}</p>}
  </>;
}

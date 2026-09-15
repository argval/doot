import { useEffect, useState } from "react";
import { fetchHistoryPolicy, saveHistoryPolicy } from "../lib/history";
import { confirmDestructive } from "../lib/native-ui";
import { SettingsGroup, SettingsSwitch } from "./SettingsChrome";

export function PrivacySection() {
  const [policy, setPolicy] = useState<{ saveHistory: boolean; retentionDays: number } | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [retention, setRetention] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetchHistoryPolicy(controller.signal).then((next) => {
      if (!controller.signal.aborted) { setPolicy(next); setRetention(next.retentionDays); }
    }).catch((error: unknown) => { if (!controller.signal.aborted) setNotice(String(error)); });
    return () => controller.abort();
  }, []);
  async function save(next: { saveHistory: boolean; retentionDays: number }) {
    setBusy(true); setNotice("");
    try {
      if (next.retentionDays > 0 && next.retentionDays !== policy?.retentionDays
        && !await confirmDestructive(`Delete history older than ${next.retentionDays} days?`, "This immediately and permanently removes older finished sessions. Active sessions are kept.", "Delete and Apply")) return;
      await saveHistoryPolicy(next);
      setPolicy(next); setNotice("Preferences saved. Recording changes apply to the next caption session.");
    } catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  }
  return <>
    <p className="settings-intro">Audio is sent to the speech provider selected for your languages. Text may also be sent to a translation provider. Doot does not save raw audio. When history is enabled, source and translated captions are stored on this computer, without application-level encryption.</p>
    <SettingsGroup label="History" aria-label="History privacy">
      <label className="settings-row">
        <span className="settings-row-copy">
          <strong>Save caption history</strong>
          <em>Applies to new sessions. Turning this off does not delete existing history.</em>
        </span>
        <SettingsSwitch
          checked={policy?.saveHistory ?? false}
          disabled={!policy || busy}
          onChange={(checked) => { if (policy) void save({ ...policy, saveHistory: checked }); }}
        />
      </label>
      <label className="settings-row">
        <span className="settings-row-copy">
          <strong>Keep history</strong>
          <em>Only finished sessions are removed. Active sessions are kept.</em>
        </span>
        <select value={retention} disabled={!policy || busy} onChange={(event) => setRetention(Number(event.target.value))}>
          <option value={0}>Until I delete it</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
      </label>
    </SettingsGroup>
    {policy && retention !== policy.retentionDays && <div className="settings-history-actions"><button disabled={busy} onClick={() => void save({ ...policy, retentionDays: retention })}>{retention ? `Delete history older than ${retention} days and apply` : "Keep history until I delete it"}</button></div>}
    <p className="settings-footnote">Retention deletion is permanent. Individual sessions can be exported or deleted from History. Provider data handling is governed by your provider account terms.</p>
    {notice && <p className="settings-footnote" role="status">{notice}</p>}
  </>;
}

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../lib/runtime";
import { getCaptionRoute, getConnectionStatus, openAudioSettings, requestScreenRecording } from "../lib/tauri";
import { updatePrefs, type DesktopPrefs } from "../lib/prefs";
import { SettingsGroup, SettingsRow } from "./SettingsChrome";

export function SetupSection({ prefs, onComplete }: { prefs: DesktopPrefs; onComplete: () => void }) {
  const [keys, setKeys] = useState({ sarvam: false, gemini: false, speechmatics: false, openai: false });
  const [provider, setProvider] = useState("sarvam");
  const [key, setKey] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const desktop = isTauriRuntime();
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void invoke<typeof keys>("credential_status").then((value) => { if (!cancelled) setKeys(value); })
      .catch(() => { if (!cancelled) setNotice("Allow Doot to access its OS credential store."); });
    return () => { cancelled = true; };
  }, [desktop]);
  async function save(remove = false) {
    setBusy(true); setNotice("");
    try {
      await invoke("save_service_key", { provider, key: remove ? "" : key });
      setKey("");
      setKeys(await invoke<typeof keys>("credential_status"));
      setNotice(remove ? "Saved key removed." : "Key saved securely. Caption service restarted. Readiness checks do not verify provider billing or key validity.");
    } catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  }
  const providerLabel = provider === "sarvam" ? "Sarvam" : provider === "gemini" ? "Gemini" : provider === "speechmatics" ? "Speechmatics" : "OpenAI";
  return <>
    <p className="settings-intro">Doot starts its caption service for you. Add your own provider keys, check audio permission, then choose languages on the floating overlay.</p>
    <SettingsGroup label="Speech services" aria-label="Speech services">
      <SettingsRow title="Speech services" subtitle="Sarvam covers English and Indic speech. Gemini covers international routes. Speechmatics and OpenAI are available for comparison trials." />
      <label className="settings-row">
        <span className="settings-row-copy"><strong>Provider</strong></span>
        <select value={provider} disabled={busy} onChange={(event) => { setProvider(event.target.value); setKey(""); }}>
          <option value="sarvam">Sarvam{keys.sarvam ? " · Saved" : ""}</option>
          <option value="gemini">Gemini{keys.gemini ? " · Saved" : ""}</option>
          <option value="speechmatics">Speechmatics{keys.speechmatics ? " · Saved" : ""}</option>
          <option value="openai">OpenAI{keys.openai ? " · Saved" : ""}</option>
        </select>
      </label>
      <form className="settings-key-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>API key<input type="password" autoComplete="off" spellCheck={false} value={key} disabled={!desktop || busy} onChange={(event) => setKey(event.target.value)} placeholder="Stored in your OS credential store" /></label>
        <button disabled={!desktop || busy || !key.trim()} type="submit">Save key</button>
      </form>
    </SettingsGroup>
    <SettingsGroup label="This computer" aria-label="This computer">
      <SettingsRow
        title={`Remove saved ${providerLabel} key`}
        chevron
        disabled={!desktop || busy || !keys[provider as keyof typeof keys]}
        onClick={() => void save(true)}
      />
      <SettingsRow
        title="Open audio permissions"
        chevron
        disabled={!desktop || busy}
        onClick={() => { void openAudioSettings().catch((error: unknown) => setNotice(String(error))); }}
      />
      <SettingsRow
        title="Check readiness"
        chevron
        disabled={!desktop || busy}
        onClick={() => {
          setBusy(true);
          void requestScreenRecording()
            .then(() => Promise.all([getConnectionStatus(), getCaptionRoute(prefs.translateEnabled ? prefs.sourceLanguage : prefs.targetLanguage, prefs.targetLanguage)]))
            .then(([status, route]) => setNotice(!status.gatewayReachable ? "Caption service is unavailable. Try Check readiness again." : status.audioPermission === "required" ? "Allow Screen & System Audio Recording, then check again." : `Ready for ${route.description}. Start captions from the overlay while a video is playing.`))
            .catch((error: unknown) => setNotice(String(error))).finally(() => setBusy(false));
        }}
      />
      <SettingsRow
        title="Check audio for 3 seconds"
        chevron
        disabled={!desktop || busy}
        onClick={() => {
          setBusy(true); setNotice("Checking system audio for 3 seconds. Play a video or music now…");
          void invoke<boolean>("check_system_audio").then((heard) => setNotice(heard ? "System audio detected. Nothing was sent or saved." : "No audio detected. Play audio on this computer and check your output device and permission."))
            .catch((error: unknown) => setNotice(String(error))).finally(() => setBusy(false));
        }}
      />
      <SettingsRow
        title="Finish setup"
        chevron
        disabled={busy}
        onClick={() => { void updatePrefs({ onboardingComplete: true }).then(onComplete).catch((error: unknown) => setNotice(String(error))); }}
      />
    </SettingsGroup>
    <p className="settings-footnote">Captions send audio to your selected providers and may incur charges. Finalized transcripts are saved locally by default; change this in Privacy. The readiness and audio checks do not send or save audio.</p>
    {notice && <p className="settings-footnote" role="status">{notice}</p>}
    {!desktop && <p className="settings-footnote">Secure key storage and audio capture are available in the desktop app.</p>}
  </>;
}

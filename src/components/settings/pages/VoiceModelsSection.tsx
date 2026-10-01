/**
 * Voice-models download section — rendered only when the wake word is
 * enabled (see GeneralPage). The STT models are a manual, one-time
 * download (~80 MB) into the app-data dir; Nila works fine without
 * them, so this is strictly opt-in and nothing downloads on its own.
 *
 * States: not installed / downloading / installed (+ size) / error.
 * "Update available" is not supported — the upstream release is pinned.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fill, type Dict } from "../../../lib/i18n";
import { isTauri, listenEvent } from "../../../lib/tauri";
import {
  MODEL_EVENTS,
  deleteSttModels,
  downloadSttModels,
  getSttModelsStatus,
  type ModelsDownloadingPayload,
  type ModelsErrorPayload,
} from "../../../lib/voice";
import { SettingsRow, SettingsSection } from "../ui";

type Status = "checking" | "installed" | "not_installed" | "downloading" | "error";

export function VoiceModelsSection({ t }: { t: Dict }) {
  const g = t.general;
  const [status, setStatus] = useState<Status>("checking");
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const alive = useRef(true);

  const check = useCallback(async () => {
    if (!isTauri()) return; // demo mode: no backend to ask
    try {
      const s = await getSttModelsStatus();
      if (!alive.current) return;
      setSizeBytes(s.size_bytes);
      if (s.status === "installed") {
        setErrorMsg(null);
        setStatus("installed");
      } else if (s.status === "downloading") {
        setStatus("downloading");
      } else if (s.error) {
        setErrorMsg(s.error);
        setStatus("error");
      } else {
        setErrorMsg(null);
        setStatus("not_installed");
      }
    } catch {
      if (alive.current) setStatus("not_installed");
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void check();
    const unlistens: Array<() => void> = [];
    let cancelled = false;
    (async () => {
      if (!isTauri()) return;
      unlistens.push(
        await listenEvent<ModelsDownloadingPayload>(
          MODEL_EVENTS.downloading,
          (p) => {
            setPct(
              p.total_bytes > 0
                ? Math.round((p.downloaded_bytes / p.total_bytes) * 100)
                : 0,
            );
            setStatus("downloading");
          },
        ),
      );
      unlistens.push(
        await listenEvent(MODEL_EVENTS.ready, () => {
          // Re-check so the installed size is picked up.
          void check();
        }),
      );
      unlistens.push(
        await listenEvent<ModelsErrorPayload>(MODEL_EVENTS.error, (p) => {
          if (cancelled) return;
          setErrorMsg(p.message);
          setStatus("error");
        }),
      );
      if (cancelled) for (const off of unlistens) off();
    })();
    return () => {
      cancelled = true;
      alive.current = false;
      for (const off of unlistens) off();
    };
  }, [check]);

  const onDownload = async () => {
    setPct(0);
    setErrorMsg(null);
    setStatus("downloading");
    try {
      const r = await downloadSttModels();
      // `started: false` means the models were already present.
      if (!r.started) await check();
    } catch {
      if (alive.current) setStatus("error");
    }
  };

  const onDelete = async () => {
    setStatus("checking");
    try {
      await deleteSttModels();
    } catch {
      // A failed delete just re-checks; the status line stays honest.
    }
    await check();
  };

  const sizeLine =
    status === "installed" && sizeBytes != null
      ? ` · ${g.voiceModelsSize}: ${(sizeBytes / 1_000_000).toFixed(1)} MB`
      : "";

  const line = (() => {
    switch (status) {
      case "checking":
        return "…";
      case "installed":
        return `${g.voiceModelsReady}${sizeLine}`;
      case "not_installed":
        return g.voiceModelsMissing;
      case "downloading":
        return fill(g.voiceModelsDownloading, { pct });
      case "error":
        return errorMsg
          ? fill(g.voiceModelsError, { msg: errorMsg })
          : g.voiceModelsFailed;
    }
  })();

  const busy = status === "checking" || status === "downloading";

  return (
    <SettingsSection title={g.voiceModelsSection}>
      <SettingsRow
        title={g.voiceModelsSection}
        description={g.voiceModelsDesc}
        control={
          status === "installed" ? (
            <button
              type="button"
              className="btn"
              disabled={!isTauri() || busy}
              onClick={() => void onDelete()}
            >
              {g.voiceModelsDelete}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={!isTauri() || busy}
              onClick={() => void onDownload()}
            >
              {g.voiceModelsDownload}
            </button>
          )
        }
      />
      <p
        className={`status-line${status === "error" ? " err" : status === "installed" ? " ok" : ""}`}
        role="status"
      >
        {line}
      </p>
    </SettingsSection>
  );
}

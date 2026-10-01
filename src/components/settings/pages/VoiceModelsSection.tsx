/**
 * Voice-models download section — rendered only when the wake word is
 * enabled (see GeneralPage). The STT models are a manual, one-time
 * download (~80 MB) into the app-data dir; Nila works fine without
 * them, so this is strictly opt-in and nothing downloads on its own.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fill, type Dict } from "../../../lib/i18n";
import { isTauri, listenEvent } from "../../../lib/tauri";
import {
  MODEL_EVENTS,
  downloadSttModels,
  getSttModelsStatus,
  type ModelsDownloadingPayload,
  type ModelsErrorPayload,
} from "../../../lib/voice";
import { SettingsRow, SettingsSection } from "../ui";

type Status = "checking" | "ready" | "missing" | "downloading" | "error";

export function VoiceModelsSection({ t }: { t: Dict }) {
  const g = t.general;
  const [status, setStatus] = useState<Status>("checking");
  const [pct, setPct] = useState(0);
  const alive = useRef(true);

  const check = useCallback(async () => {
    if (!isTauri()) return; // demo mode: no backend to ask
    try {
      const s = await getSttModelsStatus();
      if (alive.current) setStatus(s.ready ? "ready" : "missing");
    } catch {
      if (alive.current) setStatus("missing");
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
        await listenEvent(MODEL_EVENTS.ready, () => setStatus("ready")),
      );
      unlistens.push(
        await listenEvent<ModelsErrorPayload>(MODEL_EVENTS.error, () => {
          if (!cancelled) setStatus("error");
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
    setStatus("downloading");
    try {
      const r = await downloadSttModels();
      // `started: false` means the models were already present.
      if (!r.started && alive.current) setStatus("ready");
    } catch {
      if (alive.current) setStatus("error");
    }
  };

  const line = (() => {
    switch (status) {
      case "checking":
        return "…";
      case "ready":
        return g.voiceModelsReady;
      case "missing":
        return g.voiceModelsMissing;
      case "downloading":
        return fill(g.voiceModelsDownloading, { pct });
      case "error":
        return g.voiceModelsFailed;
    }
  })();

  const busy = status === "checking" || status === "downloading";

  return (
    <SettingsSection title={g.voiceModelsSection}>
      <SettingsRow
        title={g.voiceModelsSection}
        description={g.voiceModelsDesc}
        control={
          <button
            type="button"
            className="btn"
            disabled={!isTauri() || busy || status === "ready"}
            onClick={() => void onDownload()}
          >
            {g.voiceModelsDownload}
          </button>
        }
      />
      <p
        className={`status-line${status === "error" ? " err" : status === "ready" ? " ok" : ""}`}
        role="status"
      >
        {line}
      </p>
    </SettingsSection>
  );
}

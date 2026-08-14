import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

const COMMIT_HASH = (import.meta.env.VITE_COMMIT_SHA?.trim() || "dev").slice(0, 8);

export function BuildInfo() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    if (!("__TAURI_INTERNALS__" in window)) {
      setVersion("dev");
      return () => {
        active = false;
      };
    }

    void getVersion()
      .then((appVersion) => {
        if (active) {
          setVersion(appVersion);
        }
      })
      .catch(() => {
        if (active) {
          setVersion("unknown");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const displayedVersion = version ?? "…";
  const label = `TapeCapture ${displayedVersion} (${COMMIT_HASH})`;

  return (
    <span className="build-info" aria-label={label} title={label}>
      v{displayedVersion} · {COMMIT_HASH}
    </span>
  );
}

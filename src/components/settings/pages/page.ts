import type { Dict } from "../../../lib/i18n";
import type { AppSettings } from "../../../lib/types";

/** Props shared by every settings page. Changes apply immediately. */
export interface PageProps {
  t: Dict;
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}

export const APP_NAME = "Molfi";
export const APP_TAGLINE = "Leveraged trading on price predictions — on Flare.";

export function pageTitle(section?: string): string {
  return section ? `${section} — ${APP_NAME}` : APP_NAME;
}

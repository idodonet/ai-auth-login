export type Theme = "system" | "light" | "dark";
const key = "ai-auth-login.demo.theme";
export function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(key);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}
export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(key, theme);
  } catch {
    /* The current choice still applies for this page. */
  }
}

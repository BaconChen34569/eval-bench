import { useEffect, useState } from "react";

/**
 * 主题三态：跟随系统 / 浅色 / 深色。
 * 首帧前由 index.html 里的内联脚本落好 <html class="dark">，避免刷新时闪一下白底。
 */
export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "eval-bench-theme";

function resolve(choice: ThemeChoice): "light" | "dark" {
  if (choice === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return choice;
}

function apply(choice: ThemeChoice): "light" | "dark" {
  const resolved = resolve(choice);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("light", resolved === "light");
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "dark" ? "#0a0a0a" : "#ffffff");
  return resolved;
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeChoice | null;
    const initial: ThemeChoice =
      stored === "light" || stored === "dark" ? stored : "system";
    setChoice(initial);
    apply(initial);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if ((localStorage.getItem(STORAGE_KEY) as ThemeChoice) === "system") {
        apply("system");
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const update = (next: ThemeChoice) => {
    setChoice(next);
    localStorage.setItem(STORAGE_KEY, next);
    apply(next);
  };

  return [choice, update];
}

const LABELS: Record<ThemeChoice, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

export function ThemeToggle({
  choice,
  onChange,
}: {
  choice: ThemeChoice;
  onChange: (choice: ThemeChoice) => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-md border p-0.5"
      role="group"
      aria-label="主题"
    >
      {(["system", "light", "dark"] as ThemeChoice[]).map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => onChange(item)}
          aria-pressed={choice === item}
          title={`主题：${LABELS[item]}`}
          className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
            choice === item
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {item === "system" ? "自动" : item === "light" ? "浅" : "深"}
        </button>
      ))}
    </div>
  );
}

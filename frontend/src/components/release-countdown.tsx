import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { phrase, useLanguage, type Language } from "@/i18n";
import { localeFor } from "@/i18n/calendar";
import { countdownParts, nextTickDelay } from "@/lib/release-countdown";

/**
 * Re-renders only when the visible value changes (each minute above one hour, each second below), and not at all
 * while the app is hidden: the timer is cleared on `visibilitychange` and re-aligned when the app returns.
 */
function useRemaining(at: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === "hidden") return;
      const delay = nextTickDelay(at - Date.now());
      if (delay === null) return;
      timer = window.setTimeout(() => { setNow(Date.now()); schedule(); }, delay + 20);
    };
    const onVisibility = () => { if (document.visibilityState === "visible") setNow(Date.now()); schedule(); };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [at]);
  return at - now;
}

const unit = (locale: string, value: number, name: "hour" | "minute", display: "narrow" | "long") =>
  new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: display }).format(value);

function visualText(language: Language, remaining: number) {
  const locale = localeFor(language);
  const parts = countdownParts(remaining);
  if (parts.precise) {
    const two = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
    return { text: `${two.format(parts.minutes)}:${two.format(parts.seconds)}`, clock: true };
  }
  const minutes = parts.minutes ? ` ${unit(locale, parts.minutes, "minute", "narrow")}` : "";
  return { text: `${unit(locale, parts.hours, "hour", "narrow")}${minutes}`, clock: false };
}

/** Spoken once per minute at most, so VoiceOver is never interrupted by ticking seconds. */
function spokenText(language: Language, remaining: number) {
  const locale = localeFor(language);
  const minutesLeft = Math.max(1, Math.ceil(remaining / 60_000));
  const hours = Math.floor(minutesLeft / 60), minutes = minutesLeft % 60;
  const pieces = [hours ? unit(locale, hours, "hour", "long") : "", minutes ? unit(locale, minutes, "minute", "long") : ""].filter(Boolean);
  const list = typeof Intl.ListFormat === "function" ? new Intl.ListFormat(locale, { style: "long", type: "unit" }).format(pieces) : pieces.join(" ");
  return `${phrase(language, "Airs in")} ${list}`;
}

/**
 * Rolling pieces of the visible value. Each rolling piece is an inline-block, which bidi treats as one neutral
 * object: whole numbers keep their digit order in Arabic, and only the LTR mm:ss clock rolls digit by digit.
 */
function tokens(text: string, clock: boolean) {
  const runs = text.match(/\p{Nd}+|\P{Nd}+/gu) || [];
  return runs.flatMap(run => /\p{Nd}/u.test(run)
    ? (clock ? [...run] : [run]).map(value => ({ value, digits: true }))
    : [{ value: run, digits: false }]);
}

/**
 * A quiet countdown pill for the next verified release. Digits that change roll in (CSS only; instant with reduced
 * motion). At zero it disappears and changes nothing else.
 */
export default function ReleaseCountdown({ at, id, className = "" }: { at: number; id?: string; className?: string }) {
  const { language } = useLanguage();
  const remaining = useRemaining(at);
  if (remaining <= 0) return null;
  const { text, clock } = visualText(language, remaining);
  return <span id={id} className={`release-countdown ${className}`}>
    <span className="sr-only">{spokenText(language, remaining)}</span>
    <span aria-hidden="true" className="release-countdown-visual">
      <Timer className="size-3 shrink-0" strokeWidth={2.25} />
      <bdi dir={clock || language !== "ar" ? "ltr" : "rtl"} className="release-countdown-value">
        {tokens(text, clock).map(({ value, digits }, index) => digits
          // Keyed by position and value: only a number that changed remounts, which replays its roll-in.
          ? <span key={`${index}:${value}`} className="release-countdown-digit">{value}</span>
          : <span key={`${index}:${value}`}>{value}</span>)}
      </bdi>
    </span>
  </span>;
}

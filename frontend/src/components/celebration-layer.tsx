import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Trophy } from "lucide-react";
import { useLanguage } from "@/i18n";
import { celebrationSeason, celebrationTitle } from "@/i18n/celebration";
import { CELEBRATION_DURATION, STATIC_CELEBRATION_DURATION, createCelebrationGate, onCelebration, type Celebration } from "@/lib/celebration";
import { getCelebrationPreference, useCelebrationPreference } from "@/lib/celebration-preference";

type Shown = { celebration: Celebration; id: number; reduced: boolean; duration: number; check: { x: number; y: number } | null };

const reducedMotion = () => { try { return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false; } catch { return false; } };

/** Centre of the tapped control when it is on screen; otherwise just above the bottom edge (and the mobile dock). */
function checkPosition(celebration: Celebration) {
  const box = celebration.anchor;
  if (box) {
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    if (x >= 24 && y >= 24 && x <= window.innerWidth - 24 && y <= window.innerHeight - 24) return { x, y };
  }
  return { x: window.innerWidth / 2, y: window.innerHeight - 112 };
}

/** Small deterministic PRNG so each celebration is varied but stable for its id. */
function random(seed: number) {
  let t = seed + 0x6d2b79f5;
  return () => { t += 0x6d2b79f5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}

type Piece = CSSProperties & Record<`--${string}`, string>;
function pieces(level: Celebration["level"], seed: number): Piece[] {
  if (level === "episode") return [];
  const next = random(seed);
  const between = (min: number, max: number) => min + next() * (max - min);
  const count = level === "season" ? 16 : level === "caught_up" ? 30 : 44;
  const gold = level === "season" ? 0 : level === "caught_up" ? 0.22 : 0.45;
  return Array.from({ length: count }, (_, index) => {
    const side = index % 2 ? 1 : -1;
    const isGold = next() < gold;
    const color = isGold ? (next() < 0.5 ? "var(--celebrate-gold)" : "var(--celebrate-gold-soft)") : (next() < 0.6 ? "var(--celebrate-mint)" : "var(--celebrate-mint-soft)");
    if (level === "season") {
      // Soft glints drifting out around the banner.
      const angle = (index / count) * Math.PI * 2 + between(-0.2, 0.2);
      const size = between(3, 5.5);
      return { "--x": `${Math.cos(angle) * between(120, 185)}px`, "--y": `${Math.sin(angle) * between(38, 70)}px`, "--fall": `${between(4, 18)}px`, "--r": "0deg",
        "--w": `${size}px`, "--h": `${size}px`, "--radius": "999px", "--color": color, "--d": `${between(900, 1150)}ms`, "--delay": `${between(40, 200)}ms` };
    }
    const spread = level === "series" ? [90, 230] : [70, 190];
    const shape = next();
    const [w, h, radius] = shape < 0.55 ? [between(3, 4.5), between(7, 10), "1px"] : shape < 0.8 ? [between(4, 5.5), between(4, 5.5), "1px"] : [between(4, 5.5), between(4, 5.5), "999px"];
    const duration = level === "series" ? between(1400, 1900) : between(1150, 1550);
    return { "--x": `${side * between(spread[0] * (index % 3 === 0 ? 0.3 : 1), spread[1])}px`, "--y": `${between(-70, 30)}px`, "--fall": `${between(110, level === "series" ? 280 : 210)}px`,
      "--r": `${side * between(160, 520)}deg`, "--w": `${w}px`, "--h": `${h}px`, "--radius": radius, "--color": color, "--d": `${duration}ms`, "--delay": `${between(0, level === "series" ? 260 : 160)}ms` };
  });
}

function CheckMark({ double = false }: { double?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="celebrate-draw">
    {double ? <><path pathLength={1} d="M2.5 12.5l4.2 4.2L16.5 7" /><path pathLength={1} d="M11.2 16.4l.3.3L21.5 7" /></> : <path pathLength={1} d="M5 12.5l4.2 4.2L19 7" />}
  </svg>;
}

/**
 * The one place celebrations render. Mounted once at the app root; a new layer element is created for each celebration
 * and removed when it ends, so nothing stays on screen, nothing blocks input (pointer-events: none) and nothing needs
 * dismissing. Off when Settings → Appearance → Celebration Animations is off; static when the OS asks for reduced motion.
 */
export default function CelebrationLayer() {
  const enabled = useCelebrationPreference();
  const { language } = useLanguage();
  const [shown, setShown] = useState<Shown | null>(null);
  const gate = useRef(createCelebrationGate());

  useEffect(() => {
    // Lets CSS keep the pre-feature look (e.g. no progress-bar easing on Home's mini bars) when the setting is off.
    document.documentElement.dataset.celebrations = enabled ? "on" : "off";
    if (!enabled) { setShown(null); gate.current.clear(); }
  }, [enabled]);

  useEffect(() => {
    let timer = 0;
    let sequence = 0;
    const stop = onCelebration(celebration => {
      if (!getCelebrationPreference()) return;
      const reduced = reducedMotion();
      const duration = (reduced ? STATIC_CELEBRATION_DURATION : CELEBRATION_DURATION)[celebration.level];
      if (!gate.current.admit(celebration, duration)) return;
      window.clearTimeout(timer);
      const id = ++sequence;
      setShown({ celebration, id, reduced, duration, check: celebration.level === "episode" ? checkPosition(celebration) : null });
      timer = window.setTimeout(() => setShown(current => (current?.id === id ? null : current)), duration);
    });
    const cancel = () => { window.clearTimeout(timer); gate.current.clear(); setShown(null); };
    // A backgrounded tab must not resume a half-played celebration later.
    const onHidden = () => { if (document.visibilityState === "hidden") cancel(); };
    document.addEventListener("visibilitychange", onHidden);
    return () => { stop(); document.removeEventListener("visibilitychange", onHidden); window.clearTimeout(timer); gate.current.clear(); };
  }, []);

  const burst = useMemo(() => (shown && !shown.reduced ? pieces(shown.celebration.level, shown.id * 7919 + shown.celebration.key.length) : []), [shown]);
  if (!shown || !enabled || typeof document === "undefined") return null;
  const { celebration, reduced, duration, check } = shown;
  const style = { "--celebrate-duration": `${duration}ms` } as CSSProperties;

  // Keyed by id: every celebration is a fresh element (restarts cleanly, and is announced even while a dialog is open).
  return createPortal(<div key={shown.id} className="celebration-layer" data-level={celebration.level} data-reduced={reduced || undefined} style={style}>
    {celebration.level === "episode" && check
      ? <span className="celebrate-check" style={{ left: check.x, top: check.y }} aria-hidden="true"><CheckMark /></span>
      : celebration.level !== "episode" && <div className="celebrate-stage">
        <div className="celebrate-burst" aria-hidden="true">{burst.map((piece, index) => <i key={index} className="celebrate-piece" data-glint={celebration.level === "season" || undefined} style={piece} />)}</div>
        <div className="celebrate-banner" role="status" aria-live="polite">
          {celebration.level === "series" && <span className="celebrate-sheen" aria-hidden="true" />}
          <span className="celebrate-emblem" aria-hidden="true">{celebration.level === "series" ? <Trophy strokeWidth={2} /> : <CheckMark double={celebration.level === "caught_up"} />}</span>
          <span className="celebrate-copy">
            <span className="celebrate-title">{celebrationTitle(language, celebration.level)}</span>
            <span className="celebrate-subtitle"><bdi>{celebration.showName}</bdi>{celebration.level === "season" && <> · {celebrationSeason(language, celebration.season)}</>}</span>
          </span>
        </div>
      </div>}
  </div>, document.body);
}

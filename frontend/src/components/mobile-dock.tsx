import { useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { CalendarDays, Film, House, Tv } from "lucide-react";
import type { PointerEvent } from "react";

const destinations = [
  { to: "/", label: "Home", icon: House },
  { to: "/shows", label: "Shows", icon: Tv },
  { to: "/upcoming", label: "Upcoming", icon: CalendarDays },
  { to: "/movies", label: "Movies", icon: Film },
];

export default function MobileDock() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const active = Math.max(0, destinations.findIndex(({ to }) => to === pathname));
  const [highlight, setHighlight] = useState(active);
  const dock = useRef<HTMLElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const gesture = useRef<number | null>(null);

  const position = (index: number) => {
    if (bubble.current) bubble.current.style.transform = `translateX(${index * 100}%)`;
  };
  useLayoutEffect(() => {
    setHighlight(active);
    position(active);
  }, [active]);

  const update = (event: PointerEvent<HTMLElement>) => {
    const rect = dock.current!.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const valid = x >= 0 && x <= rect.width && event.clientY >= rect.top && event.clientY <= rect.bottom;
    const index = Math.min(3, Math.max(0, Math.floor(x / (rect.width / 4))));
    if (bubble.current) {
      const left = Math.max(0, Math.min(rect.width * .75, x - rect.width / 8));
      bubble.current.style.transform = `translateX(${left / (rect.width / 4) * 100}%)`;
    }
    setHighlight(valid ? index : active);
    return valid ? index : null;
  };
  const reset = () => {
    gesture.current = null;
    dock.current?.removeAttribute("data-dragging");
    setHighlight(active);
    position(active);
  };
  const start = (event: PointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || gesture.current !== null) return;
    event.preventDefault();
    gesture.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.setAttribute("data-dragging", "true");
    update(event);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    if (gesture.current === event.pointerId) update(event);
  };
  const end = (event: PointerEvent<HTMLElement>) => {
    if (gesture.current !== event.pointerId) return;
    const index = update(event);
    gesture.current = null;
    event.currentTarget.removeAttribute("data-dragging");
    if (index === null) {
      setHighlight(active);
      position(active);
    } else {
      setHighlight(index);
      position(index);
      if (index !== active) navigate(destinations[index].to);
    }
  };

  return <nav ref={dock} aria-label="Main navigation" className="mobile-dock md:hidden"
    onPointerDown={start} onPointerMove={move} onPointerUp={end}
    onPointerCancel={reset} onLostPointerCapture={() => { if (gesture.current !== null) reset(); }}>
    <span ref={bubble} className="mobile-dock-bubble" aria-hidden="true" style={{ transform: `translateX(${active * 100}%)` }} />
    {destinations.map(({ to, label, icon: Icon }, index) => <Link key={to} to={to}
      aria-current={active === index ? "page" : undefined} data-highlighted={highlight === index}
      onClick={(event) => { if (event.detail > 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) event.preventDefault(); }}
      className="mobile-dock-tab"><Icon aria-hidden="true" /><span>{label}</span></Link>)}
  </nav>;
}

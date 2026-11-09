import { cn } from "@/lib/utils";

/** Cinetra brand: the C film symbol (same artwork as the app icon) with the "Cinetra." wordmark. */
export default function BrandLogo({ size = 36, wordmark = true, className }: { size?: number; wordmark?: boolean; className?: string }) {
  return <span className={cn("flex items-center gap-2.5", className)}>
    <img src="/icon-192.png?v=2" alt="" width={size} height={size} className="shrink-0 rounded-[24%] ring-1 ring-white/10" style={{ width: size, height: size }} />
    {wordmark && <span className="text-lg font-semibold tracking-tight">Cinetra<span className="text-primary">.</span></span>}
  </span>;
}

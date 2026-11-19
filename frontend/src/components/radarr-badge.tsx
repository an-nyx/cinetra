import { AlertTriangle, Bookmark, BookmarkX, Check, Clock, Download, HardDrive, Info } from "lucide-react";
import { phrase, useLanguage } from "@/i18n";
import type { Badge } from "@/lib/radarr";

/** A Radarr status label (only states Radarr confirmed). Never a Cinetra viewing state. */
const badgeTone: Record<Badge["tone"], string> = {
  primary: "bg-primary/15 text-primary",
  warning: "bg-amber-400/15 text-amber-600 dark:text-amber-300",
  muted: "bg-muted text-muted-foreground",
};
const badgeIcon: Record<string, typeof Check> = { Monitored: Bookmark, "Not Monitored": BookmarkX, "On Disk": HardDrive, Missing: AlertTriangle, "Not Released": Clock };

export default function StatusBadge({ badge }: { badge: Badge }) {
  const { language } = useLanguage();
  const Icon = badge.key === "queue" ? (badge.tone === "warning" ? AlertTriangle : Download) : badgeIcon[badge.label] || Info;
  return <span className={`inline-flex min-h-6 items-center gap-1 rounded-full px-2 py-0.5 text-[0.7rem] font-medium ${badgeTone[badge.tone]}`}>
    <Icon aria-hidden="true" className="size-3" />{phrase(language, badge.label)}{typeof badge.progress === "number" && <bdi dir="ltr">&nbsp;· {badge.progress}%</bdi>}
  </span>;
}

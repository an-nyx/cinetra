import type { TrackingSummary } from "@/services/show.service";
import { phrase, type Language } from "@/i18n";

/** Retain the concrete season, count and identifier in provider explanations. */
function detailedReason(language: Language, text: string): string | null {
  const ar = language === "ar";
  const isolate = (value: string) => `\u2066${value}\u2069`;
  let m: RegExpMatchArray | null;
  if ((m = text.match(/^TMDB says season (\d+) has (\d+) episodes but lists (\d+)\.$/)))
    return ar ? `يشير TMDB إلى أن الموسم ${m[1]} يضم ${m[2]} حلقة، لكنه يعرض ${m[3]} فقط.` : `TMDB indique que la saison ${m[1]} compte ${m[2]} épisodes, mais n’en répertorie que ${m[3]}.`;
  if ((m = text.match(/^(S\d+E\d+) has no air date on TMDB although later episodes have aired\.$/)))
    return ar ? `لا يحدد TMDB موعد عرض للحلقة ${isolate(m[1])}، رغم عرض حلقات تالية.` : `TMDB n’indique pas de date de diffusion pour ${isolate(m[1])}, alors que des épisodes suivants ont été diffusés.`;
  if (text === "TMDB lists no regular episodes for this show.") return ar ? "لا يسرد TMDB أي حلقات عادية لهذا المسلسل." : "TMDB ne répertorie aucun épisode régulier pour cette série.";
  if (text === "TMDB episode data is incomplete.") return ar ? "بيانات الحلقات في TMDB غير مكتملة." : "Les données des épisodes sur TMDB sont incomplètes.";
  const conflict = text.replace(/ It has not been changed\.$/, "");
  let result: string | null = null;
  if ((m = conflict.match(/^Saved position (S\d+E\d+) names no season, so it cannot be placed on episodes\.$/)))
    result = ar ? `لا يحدد موضع التوقف ${isolate(m[1])} موسمًا، لذا يتعذّر ربطه بالحلقات.` : `La position ${isolate(m[1])} ne précise aucune saison et ne peut donc pas être associée aux épisodes.`;
  else if ((m = conflict.match(/^Saved position (S\d+E\d+) implies season (\d+) was watched, but TMDB does not list season (\d+)\.$/)))
    result = ar ? `يشير موضع التوقف ${isolate(m[1])} إلى مشاهدة الموسم ${m[2]}، لكن TMDB لا يسرد الموسم ${m[3]}.` : `La position ${isolate(m[1])} indique que la saison ${m[2]} a été vue, mais TMDB ne répertorie pas la saison ${m[3]}.`;
  else if ((m = conflict.match(/^Saved position (S\d+E\d+) names season (\d+), which TMDB does not list\.$/)))
    result = ar ? `يشير موضع التوقف ${isolate(m[1])} إلى الموسم ${m[2]}، وهو غير مدرج في TMDB.` : `La position ${isolate(m[1])} indique la saison ${m[2]}, absente de TMDB.`;
  else if ((m = conflict.match(/^Saved position (S\d+E\d+) is beyond the (\d+) episodes TMDB lists for season (\d+)\.$/)))
    result = ar ? `يتجاوز موضع التوقف ${isolate(m[1])} عدد حلقات الموسم ${m[3]} المدرجة في TMDB، وهو ${m[2]}.` : `La position ${isolate(m[1])} dépasse les ${m[2]} épisodes répertoriés par TMDB pour la saison ${m[3]}.`;
  else if ((m = conflict.match(/^Saved position (S\d+E\d+) includes episodes that have not aired or have no air date\.$/)))
    result = ar ? `يشمل موضع التوقف ${isolate(m[1])} حلقات لم تُعرض بعد أو ليس لها موعد عرض.` : `La position ${isolate(m[1])} comprend des épisodes non diffusés ou sans date de diffusion.`;
  else if ((m = conflict.match(/^TMDB's episode list for season (\d+) is incomplete, so saved position (S\d+E\d+) cannot be placed reliably\.$/)))
    result = ar ? `قائمة حلقات الموسم ${m[1]} في TMDB غير مكتملة، لذا يتعذّر تحديد موضع التوقف ${isolate(m[2])} بدقة.` : `La liste des épisodes de la saison ${m[1]} sur TMDB est incomplète ; la position ${isolate(m[2])} ne peut pas être située avec fiabilité.`;
  else if ((m = conflict.match(/^Saved position (S\d+E\d+) does not fit TMDB's episode list\.$/)))
    result = ar ? `موضع التوقف ${isolate(m[1])} لا يتوافق مع قائمة حلقات TMDB.` : `La position ${isolate(m[1])} ne correspond pas à la liste des épisodes sur TMDB.`;
  return result ? result + (ar ? " لم يتغير موضع التوقف." : " La position n’a pas été modifiée.") : null;
}

/** Translate provider failure codes without using provider text as an identity or changing tracking data. */
export function progressMessage(language: Language, summary: TrackingSummary) {
  const unavailable = summary.progressUnavailable;
  if (!unavailable) return null;
  if (language === "en") return unavailable;
  const labels: Record<string, string> = {
    no_tmdb_association: "No TMDB match", tmdb_auth_failed: "TMDB sign-in failed",
    tmdb_not_found: "TMDB entry missing", tmdb_unavailable: "TMDB unavailable",
    incomplete_metadata: "Episode data incomplete", saved_position_conflict: "Position conflict",
    no_released_episodes: "Not aired yet",
  };
  const descriptions: Record<string, [string, string]> = {
    no_tmdb_association: ["Cette série n’est pas liée à TMDB ; ses épisodes ne peuvent donc pas être comptés.", "المسلسل غير مرتبط بـ TMDB، لذا يتعذّر احتساب حلقاته."],
    tmdb_auth_failed: ["La connexion à TMDB a échoué ; les données des épisodes n’ont pas pu être chargées.", "تعذّر الاتصال بـ TMDB وتحميل بيانات الحلقات."],
    tmdb_not_found: ["La fiche TMDB liée est introuvable. Vérifiez la correspondance.", "تعذّر العثور على صفحة المسلسل المرتبطة في TMDB. يرجى مراجعة الربط."],
    tmdb_unavailable: ["Les données TMDB sont indisponibles pour le moment. Réessayez plus tard.", "بيانات TMDB غير متاحة حاليًا. حاول مجددًا لاحقًا."],
    no_released_episodes: ["Aucun épisode régulier n’a encore été diffusé.", "لم تُعرض أي حلقة بعد."],
    incomplete_metadata: ["Les données des épisodes sont incomplètes ; la progression ne peut pas être calculée avec fiabilité.", "بيانات الحلقات غير مكتملة، لذا يتعذّر حساب التقدم بدقة."],
    saved_position_conflict: ["La position enregistrée ne correspond pas aux données disponibles. Elle est conservée et doit être vérifiée.", "موضع التوقف المحفوظ لا يتوافق مع البيانات المتاحة. احتفظنا به ويحتاج إلى مراجعة."],
  };
  const detail = descriptions[unavailable.code];
  const specific = detailedReason(language, unavailable.detail);
  const saved = unavailable.detail.match(/Your saved position (S\d+E\d+) is kept\.$/);
  const retained = saved ? language === "ar" ? ` احتفظنا بموضع التوقف \u2066${saved[1]}\u2069.` : ` Votre position \u2066${saved[1]}\u2069 est conservée.` : "";
  return { ...unavailable, label: phrase(language, labels[unavailable.code] || unavailable.label), detail: specific || (detail ? detail[language === "fr" ? 0 : 1] + retained : unavailable.detail) };
}

export function savedPositionDescription(language: Language, season: number, episodes: number): string {
  if (language === "en") return episodes === 0
    ? season > 1 ? `Seasons 1–${season - 1} complete; Season ${season} not started.` : "Season 1 not started."
    : `${season > 1 ? `Seasons 1–${season - 1} complete; ` : ""}${episodes} episodes watched in Season ${season}.`;
  if (language === "fr") return episodes === 0
    ? season > 1 ? `Saisons 1 à ${season - 1} terminées ; saison ${season} non commencée.` : "Saison 1 non commencée."
    : `${season > 1 ? `Saisons 1 à ${season - 1} terminées ; ` : ""}${episodes} épisode${episodes > 1 ? "s" : ""} vu${episodes > 1 ? "s" : ""} dans la saison ${season}.`;
  if (episodes === 0) return season === 1 ? "لم تبدأ الموسم الأول." : `أكملت المواسم من 1 إلى ${season - 1}، ولم تبدأ الموسم ${season} بعد.`;
  return `${season > 1 ? `أكملت المواسم من 1 إلى ${season - 1}، و` : ""}شاهدت ${episodes} من حلقات الموسم ${season}.`;
}

export function watchCounts(language: Language, watched: number, released: number) {
  if (language === "fr") return `${watched} vu${watched > 1 ? "s" : ""} · ${released} épisode${released > 1 ? "s" : ""} diffusé${released > 1 ? "s" : ""}`;
  if (language === "ar") return `شوهد ${watched} · الحلقات المعروضة: ${released}`;
  return `${watched} effectively watched · ${released} released episodes`;
}
export function watchRecordCounts(language: Language, explicit: number, inferred: number) {
  if (language === "fr") return `${explicit} enregistré${explicit > 1 ? "s" : ""} individuellement · ${inferred} pris en compte par la position enregistrée`;
  if (language === "ar") return `المسجلة بشكل منفصل: ${explicit} · المحتسبة من موضع التوقف: ${inferred}`;
  return `${explicit} individually logged · ${inferred} covered by saved position`;
}

export function completionNotice(language: Language, summary: TrackingSummary): string | null {
  if (!summary.statusProgressNote) return null;
  if (language === "en") return summary.statusProgressNote;
  if (!summary.countDataAvailable) return language === "ar"
    ? "حالة المشاهدة التي اخترتها هي «مكتمل»، لكن لا يمكن التحقق من اكتمال الحلقات لأن بياناتها غير متاحة من TMDB."
    : "Votre statut est « Terminé », mais les données TMDB des épisodes sont indisponibles ; la fin de la série ne peut pas être vérifiée.";
  if (summary.remainingCount > 0) return language === "ar"
    ? `حالة المشاهدة التي اخترتها هي «مكتمل»، لكن لم تتأكد مشاهدة ${summary.remainingCount} من الحلقات المعروضة. لم تتغير حالتك.`
    : `Votre statut est « Terminé », mais ${summary.remainingCount} épisode${summary.remainingCount > 1 ? "s" : ""} diffusé${summary.remainingCount > 1 ? "s ne sont" : " n’est"} pas confirmé${summary.remainingCount > 1 ? "s" : ""} comme vu${summary.remainingCount > 1 ? "s" : ""}. Votre statut reste inchangé.`;
  return language === "ar" ? "حالة المشاهدة التي اخترتها هي «مكتمل»، لكن البيانات المتاحة لا تؤكد اكتمال المشاهدة. لم تتغير حالتك." : "Votre statut est « Terminé », mais les données disponibles ne permettent pas de le vérifier. Votre statut reste inchangé.";
}

export function newSeasonMessage(language: Language, season: number, count: number) {
  if (language === "ar") return `الموسم ${season} · الحلقات المعروضة التي لم تشاهدها: ${count}. لا تزال حالة المشاهدة «مكتمل».`;
  if (language === "fr") return `Saison ${season} · ${count} épisode${count > 1 ? "s" : ""} diffusé${count > 1 ? "s" : ""} non vu${count > 1 ? "s" : ""}. Votre statut reste « Terminé ».`;
  return `Season ${season} · ${count} released, unwatched episode${count === 1 ? "" : "s"}. Your personal status is still Completed.`;
}
export function nextEpisodeMessage(language: Language, date: string | null, count: number) {
  const safeDate = date ? `\u2066${date}\u2069` : "—";
  if (language === "ar") return `عُرضت في ${safeDate} · الحلقات المتبقية: ${count}`;
  if (language === "fr") return `Diffusé le ${safeDate} · ${count} restant${count > 1 ? "s" : ""}`;
  return `Released ${safeDate} · ${count} remaining`;
}

export function coverageMessage(language: Language, c: {evaluatedShows: number; verifiedShows: number; verifiedByExternalId: number; verifiedByTitle: number}) {
  if (language === 'ar') return `المسلسلات التي تم التحقق منها: ${c.evaluatedShows} · طابقنا ${c.verifiedShows} على TVMaze (${c.verifiedByExternalId} باستخدام معرّف TheTVDB/IMDb${c.verifiedByTitle ? `، و${c.verifiedByTitle} باستخدام العنوان وموعد العرض الأول والملخص` : ''}).`;
  if (language === 'fr') return `${c.evaluatedShows} série(s) vérifiée(s) · ${c.verifiedShows} correspondance(s) sur TVMaze (${c.verifiedByExternalId} par identifiant TheTVDB/IMDb${c.verifiedByTitle ? `, ${c.verifiedByTitle} par titre, première et synopsis` : ''}).`;
  return `${c.evaluatedShows} show${c.evaluatedShows === 1 ? '' : 's'} checked · ${c.verifiedShows} matched on TVMaze (${c.verifiedByExternalId} by TheTVDB/IMDb ID${c.verifiedByTitle ? `, ${c.verifiedByTitle} by title, premiere and synopsis` : ''}).`;
}
export function excludedEpisodesMessage(language: Language, repeats: number, duplicates: number, specials: number) {
  if (language === 'ar') return `تُعرض الحلقات الجديدة فقط؛ استُبعدت الإعادات: ${repeats}، والتكرارات: ${duplicates}، والحلقات الخاصة: ${specials}.`;
  if (language === 'fr') return `Seules les premières diffusions sont affichées : ${repeats} rediffusion(s), ${duplicates} doublon(s) et ${specials} épisode(s) spécial(aux) exclus.`;
  return `Only first-run episodes are listed: ${repeats} repeat${repeats === 1 ? '' : 's'}, ${duplicates} duplicate${duplicates === 1 ? '' : 's'} and ${specials} special${specials === 1 ? '' : 's'} left out.`;
}

export function movieWatchHistory(language: Language, count: number, date: string) {
  if (language === "ar") return `عدد المشاهدات: ${count} · آخر مشاهدة: ${date}`;
  if (language === "fr") return `Vu ${count} fois · Dernier visionnage : ${date}`;
  return `Watched ${count} ${count === 1 ? 'time' : 'times'} · Last watched ${date}`;
}
export function ratingLabel(language: Language, stars: number) {
  if (language === "ar") return `التقييم: ${stars} من 5 نجوم (${stars * 2}/10)`;
  if (language === "fr") return `Noter ${stars} étoile${stars > 1 ? 's' : ''} (${stars * 2}/10)`;
  return `Rate ${stars} ${stars === 1 ? 'star' : 'stars'} (${stars * 2}/10)`;
}
export function verifiedShowCounts(language: Language, verified: number, total: number) {
  if (language === 'ar') return `إجمالي الحلقات المشاهَدة يشمل ${verified} من أصل ${total} مسلسل، وهي المسلسلات التي تم التحقق من بيانات حلقاتها.`;
  if (language === 'fr') return `Le nombre d’épisodes vus couvre ${verified} séries sur ${total}, celles dont les données ont été vérifiées.`;
  return `Episodes watched counts ${verified} of ${total} shows with verified episode data.`;
}
export function unavailableShowCounts(language: Language, count: number) {
  if (language === 'ar') return `بيانات الحلقات غير متاحة لعدد ${count} من المسلسلات.`;
  if (language === 'fr') return `Données des épisodes indisponibles pour ${count} série${count > 1 ? 's' : ''}.`;
  return `Episode data unavailable for ${count} show${count === 1 ? '' : 's'}.`;
}

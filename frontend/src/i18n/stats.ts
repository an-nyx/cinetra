import { useLanguage, type Language } from "@/i18n";
import { localeFor } from "@/i18n/calendar";

/** Copy for My Cinema Stats (English, French, Arabic). `{n}`, `{a}`, `{b}` are replaced with formatted numbers. */
const text = {
  title: ["My Cinema Stats", "Mes stats ciné", "إحصاءاتي السينمائية"],
  eyebrow: ["Your library in numbers", "Votre bibliothèque en chiffres", "مكتبتك بالأرقام"],
  back: ["Back", "Retour", "رجوع"],
  loading: ["Loading your statistics", "Chargement de vos statistiques", "جارٍ تحميل إحصاءاتك"],
  error: ["Your statistics could not be loaded.", "Impossible de charger vos statistiques.", "تعذّر تحميل إحصاءاتك."],
  retry: ["Retry", "Réessayer", "إعادة المحاولة"],
  refresh: ["Refresh", "Actualiser", "تحديث"],
  pending: ["Some details are still loading from TMDB. Refresh in a moment for complete totals.", "Certains détails sont encore en cours de chargement depuis TMDB. Actualisez dans un instant pour des totaux complets.", "لا تزال بعض التفاصيل قيد التحميل من TMDB. حدّث الصفحة بعد لحظات للحصول على مجاميع كاملة."],
  emptyTitle: ["Nothing to count yet", "Rien à compter pour l’instant", "لا شيء لعدّه بعد"],
  emptyBody: ["Add shows and movies and mark what you watch. Your statistics will appear here.", "Ajoutez des séries et des films et indiquez ce que vous regardez. Vos statistiques apparaîtront ici.", "أضف مسلسلات وأفلامًا وحدّد ما تشاهده، وستظهر إحصاءاتك هنا."],
  goShows: ["Go to Shows", "Aller aux séries", "الذهاب إلى المسلسلات"],
  goMovies: ["Go to Movies", "Aller aux films", "الذهاب إلى الأفلام"],
  watchTime: ["Estimated watch time", "Temps de visionnage estimé", "وقت المشاهدة التقديري"],
  hours: ["h", "h", "س"],
  minutes: ["min", "min", "د"],
  days: ["About {n} days of viewing", "Environ {n} jours de visionnage", "نحو {n} يوم من المشاهدة"],
  days_one: ["About 1 day of viewing", "Environ 1 jour de visionnage", "نحو يوم واحد من المشاهدة"],
  tv: ["TV episodes", "Épisodes TV", "حلقات المسلسلات"],
  movies: ["Movies", "Films", "الأفلام"],
  watchTimeNote: ["Estimated from TMDB runtimes. Each watched episode and movie counts once; rewatches are not included.", "Estimé d’après les durées TMDB. Chaque épisode et film vu compte une fois ; les revisionnages ne sont pas inclus.", "تقدير يعتمد على مدد العرض في TMDB. تُحتسب كل حلقة وكل فيلم مرة واحدة، ولا تُحتسب إعادة المشاهدة."],
  estimatedEpisodes: ["{n} episodes have no TMDB runtime and use their show’s typical episode length.", "{n} épisodes sans durée TMDB utilisent la durée habituelle de leur série.", "{n} حلقة بلا مدة في TMDB، فاستُخدمت المدة المعتادة لحلقات مسلسلها."],
  estimatedEpisodes_one: ["1 episode has no TMDB runtime and uses its show’s typical episode length.", "1 épisode sans durée TMDB utilise la durée habituelle de sa série.", "حلقة واحدة بلا مدة في TMDB، فاستُخدمت المدة المعتادة لحلقات مسلسلها."],
  noRuntime: ["{n} titles have no runtime at all and add no time.", "{n} titres n’ont aucune durée et n’ajoutent pas de temps.", "{n} عنوانًا بلا أي مدة، فلا تضيف وقتًا."],
  noRuntime_one: ["1 title has no runtime at all and adds no time.", "1 titre n’a aucune durée et n’ajoute pas de temps.", "عنوان واحد بلا أي مدة، فلا يضيف وقتًا."],
  episodesWatched: ["Episodes watched", "Épisodes vus", "الحلقات المشاهدة"],
  showsCompleted: ["Shows completed", "Séries terminées", "مسلسلات مكتملة"],
  moviesWatched: ["Movies watched", "Films vus", "أفلام شوهدت"],
  avgRating: ["Average rating", "Note moyenne", "متوسط التقييم"],
  episodeSources: ["{a} recorded · {b} from saved positions", "{a} enregistrés · {b} depuis les positions", "{a} مسجّلة · {b} من المواضع المحفوظة"],
  completedDetail: ["{n} fully watched by episode data", "{n} vues en entier d’après les épisodes", "{n} شوهدت كاملة حسب بيانات الحلقات"],
  watchlistDetail: ["{n} on your watchlist", "{n} dans votre liste", "{n} في قائمة المشاهدة"],
  ratedDetail: ["across {n} rated movies", "sur {n} films notés", "من {n} فيلمًا مقيَّمًا"],
  ratedDetail_one: ["from 1 rated movie", "sur 1 film noté", "من فيلم واحد مقيَّم"],
  notRated: ["Not rated yet", "Pas encore de note", "لا تقييمات بعد"],
  notCounted: ["{n} shows with progress are left out because their episode data can’t be verified, the same rule as on Home.", "{n} séries avec progression sont exclues car leurs épisodes ne peuvent pas être vérifiés, comme sur l’accueil.", "استُبعد {n} مسلسلًا فيه تقدم لأن بيانات حلقاته لا يمكن التحقق منها، كما في الصفحة الرئيسية."],
  notCounted_one: ["1 show with progress is left out because its episode data can’t be verified, the same rule as on Home.", "1 série avec progression est exclue car ses épisodes ne peuvent pas être vérifiés, comme sur l’accueil.", "استُبعد مسلسل واحد فيه تقدم لأن بيانات حلقاته لا يمكن التحقق منها، كما في الصفحة الرئيسية."],
  statusSplit: ["{a} watching · {b} dropped", "{a} en cours · {b} abandonnées", "{a} قيد المشاهدة · {b} متروكة"],
  genres: ["Most-watched genres", "Genres les plus vus", "الأنواع الأكثر مشاهدة"],
  sortGenres: ["Rank genres by", "Classer les genres par", "ترتيب الأنواع حسب"],
  byTime: ["Time", "Temps", "الوقت"],
  byTitles: ["Titles", "Titres", "العناوين"],
  titles: ["{n} titles", "{n} titres", "{n} عنوان"],
  titles_one: ["1 title", "1 titre", "عنوان واحد"],
  genresEmpty: ["Genres appear once you’ve watched something.", "Les genres apparaîtront dès que vous aurez vu quelque chose.", "ستظهر الأنواع بعد أن تشاهد شيئًا."],
  genresMissing: ["{n} watched titles have no genre data.", "{n} titres vus n’ont pas de genre.", "{n} عنوانًا شوهد بلا بيانات نوع."],
  genresMissing_one: ["1 watched title has no genre data.", "1 titre vu n’a pas de genre.", "عنوان واحد شوهد بلا بيانات نوع."],
  ratings: ["Your ratings", "Vos notes", "تقييماتك"],
  ratingsNote: ["Your own ratings, never TMDB scores. Cinetra keeps personal ratings for movies only, so TV shows aren’t rated here.", "Vos propres notes, jamais celles de TMDB. Cinetra ne garde des notes personnelles que pour les films ; les séries ne sont donc pas notées ici.", "تقييماتك أنت، وليست تقييمات TMDB. يحفظ Cinetra التقييمات الشخصية للأفلام فقط، لذا لا تظهر تقييمات للمسلسلات هنا."],
  distribution: ["Rating distribution", "Répartition des notes", "توزيع التقييمات"],
  ratingBar: ["{a} out of 10: {b} movies", "{a} sur 10 : {b} films", "{a} من 10: {b} فيلم"],
  ratingBar_one: ["{a} out of 10: 1 movie", "{a} sur 10 : 1 film", "{a} من 10: فيلم واحد"],
  highestRated: ["Highest-rated movies", "Films les mieux notés", "الأفلام الأعلى تقييمًا"],
  ratingsEmpty: ["Rate movies to see your distribution and favorites.", "Notez des films pour voir votre répartition et vos favoris.", "قيّم الأفلام لترى توزيع تقييماتك ومفضلاتك."],
  yourRating: ["Your rating: {n} out of 10", "Votre note : {n} sur 10", "تقييمك: {n} من 10"],
  yearInCinema: ["Year in Cinema", "Votre année ciné", "عامك السينمائي"],
  chooseYear: ["Choose a year", "Choisir une année", "اختر سنة"],
  yearNote: ["Based only on when you marked episodes watched or logged a movie viewing in Cinetra. Release dates are never used.", "Basé uniquement sur la date à laquelle vous avez marqué des épisodes vus ou enregistré un visionnage de film dans Cinetra. Les dates de sortie ne sont jamais utilisées.", "يعتمد فقط على وقت تحديدك للحلقات كمُشاهدة أو تسجيلك لمشاهدة فيلم في Cinetra. لا تُستخدم تواريخ الإصدار أبدًا."],
  yearEmpty: ["No dated viewing records yet", "Aucun visionnage daté pour l’instant", "لا توجد سجلات مشاهدة مؤرخة بعد"],
  yearEmptyBody: ["Saved positions and Watched statuses carry no date, so they can’t be placed in a year. Episodes you mark watched from now on will appear here.", "Les positions enregistrées et les statuts « Vu » n’ont pas de date et ne peuvent pas être placés dans une année. Les épisodes que vous marquerez désormais apparaîtront ici.", "المواضع المحفوظة وحالات «شوهد» بلا تاريخ، لذا لا يمكن وضعها في سنة. ستظهر هنا الحلقات التي تحددها كمُشاهدة من الآن."],
  yearEpisodes: ["Episodes", "Épisodes", "الحلقات"],
  yearMovies: ["Movie viewings", "Films vus", "مشاهدات الأفلام"],
  yearTime: ["Watch time", "Temps", "الوقت"],
  monthly: ["Watch time by month", "Temps de visionnage par mois", "وقت المشاهدة حسب الشهر"],
  monthBar: ["{a}: {b}", "{a} : {b}", "{a}: {b}"],
  monthDetail: ["Episodes {a} · Movies {b}", "Épisodes {a} · Films {b}", "الحلقات {a} · الأفلام {b}"],
  topShows: ["Most-watched shows", "Séries les plus vues", "المسلسلات الأكثر مشاهدة"],
  topGenres: ["Top genres", "Genres principaux", "أبرز الأنواع"],
  episodesShort: ["{n} ep.", "{n} ép.", "{n} حلقة"],
  bulk: ["{n} episodes were logged together (for example with “Mark season watched”), so they fall in the month you logged them.", "{n} épisodes ont été enregistrés ensemble (par exemple avec « Marquer la saison vue ») et comptent pour le mois de l’enregistrement.", "سُجّلت {n} حلقة دفعة واحدة (مثل «تحديد الموسم كمُشاهد»)، لذا تُحسب في شهر تسجيلها."],
  bulk_one: ["1 episode was logged together with others.", "1 épisode a été enregistré avec d’autres.", "سُجّلت حلقة واحدة مع غيرها."],
  yearNoRuntime: ["{n} records this year have no runtime and add no time.", "{n} enregistrements de cette année n’ont pas de durée et n’ajoutent pas de temps.", "{n} سجلًا هذا العام بلا مدة، فلا تضيف وقتًا."],
  yearNoRuntime_one: ["1 record this year has no runtime and adds no time.", "1 enregistrement de cette année n’a pas de durée et n’ajoute pas de temps.", "سجل واحد هذا العام بلا مدة، فلا يضيف وقتًا."],
  undated: ["Not placed in any year: {a} episodes from saved positions and {b} watched movies without a logged viewing date.", "Dans aucune année : {a} épisodes issus de positions enregistrées et {b} films vus sans date de visionnage.", "غير موزعة على أي سنة: {a} حلقة من المواضع المحفوظة و{b} فيلمًا شوهد دون تاريخ مشاهدة مسجّل."],
  howCalculated: ["How these numbers are calculated", "Comment ces chiffres sont calculés", "كيف تُحسب هذه الأرقام"],
  timeZone: ["Months use your time zone ({n}).", "Les mois suivent votre fuseau horaire ({n}).", "تُحسب الأشهر حسب منطقتك الزمنية ({n})."],
} as const satisfies Record<string, readonly [string, string, string]>;

export type StatsKey = keyof typeof text;

export function statsText(language: Language, key: StatsKey, values: Record<string, string | number> = {}): string {
  const locale = localeFor(language);
  // Singular wording when the counted value is exactly one (the count is `n`, or `b` for ratingBar).
  const count = key === "ratingBar" ? values.b : values.n;
  const one = `${key}_one` as StatsKey;
  const chosen = typeof count === "number" && one in text && new Intl.PluralRules(locale).select(count) === "one" ? one : key;
  const template = text[chosen][language === "fr" ? 1 : language === "ar" ? 2 : 0];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name];
    return typeof value === "number" ? value.toLocaleString(locale) : value ?? "";
  });
}

export function useStatsText() {
  const { language } = useLanguage();
  return { language, locale: localeFor(language), s: (key: StatsKey, values?: Record<string, string | number>) => statsText(language, key, values) };
}

/**
 * Maps a ScanVerse route key + params to a Discord Rich Presence payload.
 *
 * Two ways this module is fed:
 *   1. URL-based detection in main.js (basic data only — id, type, etc.)
 *   2. Frontend hook via window.scanverse.setPresence (rich data — title, cover, author)
 *
 * Frontend calls override URL-based ones because they fire later with more info.
 *
 * Per spec:
 *   - No small image (always omitted)
 *   - Large image = cover URL when available, else "scanverse_logo" fallback
 *   - Each route gets a custom (details, state) pair
 */

const FALLBACK_LARGE_KEY = 'scanverse_logo'; // uploaded to Discord Dev Portal
// Used for two purposes: prefixing relative image URLs so Discord can
// fetch /uploads/avatars/... and building the "Voir l'œuvre" button link.
// Beta URL until scanverse.fr DNS flips over to the same deployment.
const SITE_URL = process.env.SCANVERSE_PUBLIC_URL || 'https://www.scanverse.online';
// Public Discord invite for the community server. Surfaces on every RPC
// payload via buildDefaultButtons() so anyone seeing a friend on ScanVerse
// is one click away from joining the chat.
const DISCORD_INVITE_URL = 'https://discord.gg/scanverse';

/**
 * Two RPC buttons added to *every* presence payload that doesn't already
 * carry a context-specific button (manga / reader). Discord caps at 2
 * buttons per activity, so on manga/reader pages where we already have
 * "Voir l'œuvre" we drop the generic site button and keep Discord —
 * those users are already on the site, they don't need a button to it.
 */
function buildDefaultButtons() {
  return [
    { label: 'Ouvrir ScanVerse', url: SITE_URL },
    { label: 'Rejoindre le Discord', url: DISCORD_INVITE_URL },
  ];
}

// Maps the API `sort` query value to a human-readable label for RPC.
// Keep in sync with frontend/src/components/manga/CatalogFilters.jsx.
const SORT_LABELS = {
  recent:    'Nouveautés',
  popular:   'Plus populaires',
  rating:    'Mieux notés',
  alpha:     'Ordre alphabétique',
  trending:  'Tendances',
};

function getPresenceForRoute(route, params = {}, extras = {}) {
  const base = {
    largeImageKey: FALLBACK_LARGE_KEY,
    largeImageText: 'ScanVerse',
    // Default buttons; overridden by manga/reader paths where we want to
    // surface "Voir l'œuvre" instead of "Ouvrir ScanVerse".
    buttons: buildDefaultButtons(),
  };

  // Live session activity — shows "X en ligne" alongside the route info so
  // people can see how busy ScanVerse is in real time. Polled in main.js
  // every 30 s; injected here from extras.onlineCount.
  const online = Number(extras.onlineCount) || 0;
  // Only surface the count when it's *socially meaningful* — seeing
  // "1 en ligne" while you're the only one connected is just noise. From
  // 2+ it starts feeling like a community.
  const onlineSuffix = online > 1 ? ` · ${online} en ligne` : '';
  // Discord party / Join feature was removed: requires Discord "Detectable
  // Game" verification to be useful (so friends can auto-launch the app),
  // which we don't have at MVP. Without that, the "Rejoint" button only
  // worked when the friend already had the desktop app running — too
  // fragile to keep. We can re-enable this when ScanVerse is verified.

  switch (route) {
    case 'home':
      return {
        ...base,
        details: "Sur l'accueil",
        state: 'Parcourt la bibliothèque' + onlineSuffix,
      };

    case 'catalogue': {
      // Build a contextual state line from whatever filter info we have:
      //   - explicit search query → "Recherche : naruto"
      //   - genre filter         → "Shōnen, Romance"
      //   - sort filter          → "Mieux notés"
      //   - fallback             → "Mangas"/"Comics" with online count
      // The frontend pushes labelled genres (proper case) via the hook;
      // when only the URL-based fallback fires we still show the slugs,
      // which is way better than the generic "Parcourt le catalogue".
      const typeLabel = params.type === 'comics' ? 'Comics' : 'Mangas';
      let stateText;
      if (params.q && params.q.trim()) {
        stateText = `Recherche : ${truncate(params.q.trim(), 64)}`;
      } else if (Array.isArray(params.genres) && params.genres.length > 0) {
        const top = params.genres.slice(0, 2).join(', ');
        const more = params.genres.length > 2 ? ` +${params.genres.length - 2}` : '';
        stateText = `${truncate(top, 60)}${more}`;
      } else if (params.sort) {
        stateText = SORT_LABELS[params.sort] || `Tri : ${params.sort}`;
      } else {
        stateText = typeLabel + onlineSuffix;
      }
      const detailsText = params.q || (params.genres && params.genres.length > 0) || params.sort
        ? `Filtre ${typeLabel.toLowerCase()}`
        : 'Parcourt le catalogue';
      return {
        ...base,
        details: detailsText,
        state: stateText,
      };
    }

    case 'manga': {
      const cover = sanitizeImage(params.cover);
      const title = params.title || 'une œuvre';
      // Author/year are nice when we have them. Otherwise show what the
      // user is actually doing on the page rather than echoing the app
      // name (which Discord already prints on line 1 — duplication looks bad).
      return {
        ...base,
        _sessionKey: `manga:${params.id || 'unknown'}`,
        details: `Consulte ${truncate(title, 96)}`,
        state: truncate(params.author || params.year || 'Choisit un chapitre', 96),
        largeImageKey: cover || FALLBACK_LARGE_KEY,
        largeImageText: truncate(params.title || 'ScanVerse', 96),
        buttons: buildMangaButton(params.id),
      };
    }

    case 'reader': {
      const cover = sanitizeImage(params.cover);
      const title = params.title || 'une œuvre';
      // Strip the "s1_scans_..." slug noise so Discord shows "Tome 1" /
      // "Chapitre 6" / "Chapitre 1089" instead of the raw catalogue id.
      const chapter = cleanChapterLabel(params.chapter, params.id);
      // Tomes / Intégrales already carry their own label ("Tome 1") and
      // sound weird with a "Chapitre " prefix. Detect those and use the
      // label as-is; for everything else we keep the "Chapitre <N>" copy.
      const isVolumeLabel = /^(Tome|Intégrale|Hors-série)\s/.test(chapter);
      const chapterLine = isVolumeLabel ? chapter : `Chapitre ${chapter}`;
      // Page counter — appended only when both currentPage and totalPages
      // are valid numbers, so we don't show "page undefined/undefined".
      const pageInfo =
        Number.isFinite(params.currentPage) && Number.isFinite(params.totalPages) && params.totalPages > 0
          ? ` · page ${params.currentPage}/${params.totalPages}`
          : '';
      // Idle path — the user has been on the same page > 2 min without any
      // input. We surface a clear "en pause" badge so friends know the
      // session isn't actually progressing right now. Session timer keeps
      // running because the user is still on this manga.
      if (params.idle) {
        return {
          ...base,
          _sessionKey: `reader:${params.id || 'unknown'}`,
          details: `💤 Inactif sur ${truncate(title, 95)}`,
          state: truncate(`${chapterLine}${pageInfo}`, 128),
          largeImageKey: cover || FALLBACK_LARGE_KEY,
          largeImageText: truncate(params.title || 'ScanVerse', 96),
          buttons: buildMangaButton(params.id),
        };
      }
      return {
        ...base,
        // Session is scoped to manga (not chapter) so the elapsed timer
        // keeps running across chapter changes — mirrors a real reading
        // session.
        _sessionKey: `reader:${params.id || 'unknown'}`,
        details: `Lit ${truncate(title, 96)}`,
        state: truncate(`${chapterLine}${pageInfo}`, 128),
        largeImageKey: cover || FALLBACK_LARGE_KEY,
        largeImageText: truncate(params.title || 'ScanVerse', 96),
        buttons: buildMangaButton(params.id),
      };
    }

    case 'profile': {
      const avatar = sanitizeImage(params.avatar);
      const handle = params.username
        ? `@${truncate(params.username, 30)}`
        : 'Page profil';
      return {
        ...base,
        details: params.isOwn ? 'Sur son profil' : 'Regarde un profil',
        state: handle,
        largeImageKey: avatar || FALLBACK_LARGE_KEY,
        largeImageText: params.username ? `@${truncate(params.username, 96)}` : 'ScanVerse',
      };
    }

    case 'friends':
      return {
        ...base,
        details: 'Gère ses amis',
        state: online > 1 ? `${online} en ligne` : "Liste d'amis",
      };

    case 'wrapped':
      return {
        ...base,
        details: 'Regarde son Wrapped',
        state: `Année ${params.year || new Date().getFullYear()}`,
      };

    case 'admin':
      return { ...base, details: 'Espace admin', state: 'Tableau de bord' };

    case 'login':
      return { ...base, details: 'Se connecte', state: 'Authentification' };

    case 'register':
      return { ...base, details: 'Crée un compte', state: 'Inscription' };

    case 'settings':
      return { ...base, details: 'Personnalise son profil', state: 'Réglages du compte' };

    case 'settings-blocked':
      return { ...base, details: 'Gère ses blocages', state: 'Liste des comptes bloqués' };

    case 'settings-privacy':
      return { ...base, details: 'Règle sa confidentialité', state: 'Visibilité du profil' };

    case 'settings-appearance':
      return { ...base, details: 'Personnalise son thème', state: 'Apparence du profil' };

    case 'settings-music':
      return { ...base, details: 'Choisit sa musique', state: 'Musique du profil' };

    case 'settings-reader':
      return { ...base, details: 'Règle son lecteur', state: 'Préférences de lecture' };

    case 'universe':
      return { ...base, details: 'Explore un univers', state: 'Saga / multivers' };

    case 'suggestions':
      return { ...base, details: 'Lit les suggestions', state: 'Idées de la communauté' };

    case 'premium':
      return { ...base, details: 'Découvre Premium', state: 'Offre payante' };

    case 'about':
      return { ...base, details: 'À propos de ScanVerse', state: 'Présentation du projet' };

    case 'contact':
      return { ...base, details: 'Page contact', state: 'Nous écrire' };

    case 'privacy':
      return { ...base, details: 'Politique de confidentialité', state: 'Mentions légales' };

    case 'terms':
      return { ...base, details: "Conditions d'utilisation", state: 'Mentions légales' };

    case 'changelog':
      return { ...base, details: 'Lit les notes de version', state: 'Historique des updates' };

    case 'messages': {
      // Privacy: never leak the @handle of the person you're DMing
      // through the RPC presence — Discord broadcasts your activity
      // to every friend, and "Discute avec @samy" would tell each of
      // them who else you're talking to. Same wording for both views.
      const onThread = !!params.handle;
      return {
        ...base,
        details: onThread ? 'Discussion privée' : 'Dans la messagerie',
        state: onThread ? 'En conversation' : ('Boîte de réception' + onlineSuffix),
      };
    }

    case 'notfound':
      return { ...base, details: "S'est perdu", state: 'Page introuvable' };

    default:
      return { ...base, details: 'Sur ScanVerse', state: 'En exploration' };
  }
}

function truncate(str, max) {
  if (!str) return ' ';
  const s = String(str);
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Cleans up a chapter "id" before it ends up in Discord's activity state.
 * Catalogue / comics-tracker chapter ids are stored as long slugs like
 *   s1_scans__dc__dc_absolute__absolute_superman_Absolute_Superman_2025_T1
 * which the frontend hook passes verbatim when no admin-edited chapter
 * title is set. The previous build leaked that slug straight into the
 * "Chapitre s1_scans_..." line on Discord, which kazu reported.
 *
 * Same regex catalogue as the site's deriveChapterLabel:
 *   ..._T(N)   → "Tome N"
 *   ..._INT(N) → "Intégrale N"
 *   ..._HS(N)  → "Hors-série N"
 *   ..._<num>  → bare number (the "Chapitre " prefix is added by the caller)
 *   anything else → prettified suffix (underscores → spaces)
 *
 * `mangaId` is optional — when supplied we strip it as a prefix to keep
 * the label tight (the manga title already shows in the activity details
 * line, no need to repeat it inside the chapter label).
 */
function cleanChapterLabel(rawChapter, mangaId) {
  if (rawChapter == null) return '?';
  let s = String(rawChapter);
  // Bare numeric chapter ("1089", "5.5") — pass through unchanged.
  if (/^\d+(?:\.\d+)?$/.test(s)) return s;
  // Strip the parent manga slug if it leaked into the chapter id.
  if (mangaId && typeof mangaId === 'string' && s.startsWith(mangaId + '_')) {
    s = s.slice(mangaId.length + 1);
  }
  let m = s.match(/_T(\d+)$/i);
  if (m) return `Tome ${parseInt(m[1], 10)}`;
  m = s.match(/_INT(\d+)$/i);
  if (m) return `Intégrale ${parseInt(m[1], 10)}`;
  m = s.match(/_HS(\d+)$/i);
  if (m) return `Hors-série ${parseInt(m[1], 10)}`;
  // Trailing bare number — drop the prefix slug, keep the issue number.
  m = s.match(/_(\d+(?:\.\d+)?)$/);
  if (m) return m[1];
  // Last resort — strip "s1_scans_" prefix if still there, then prettify.
  s = s.replace(/^s1_scans_+/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return s || '?';
}

/**
 * Discord Rich Presence supports passing a full HTTPS URL as largeImageKey
 * (Discord proxies it through their CDN). LAN URLs (192.168.x.x) won't work
 * because Discord's servers can't reach them — those return null and we fall
 * back to the static "scanverse_logo" asset.
 *
 * The frontend often passes RELATIVE URLs for in-house assets ("/uploads/
 * avatars/abc.jpg" for user avatars, "/proxy/cover/..." for MangaDex
 * covers, etc.). Those are reachable to Discord *if* we prefix them with
 * the public site URL — so we do that automatically here. Without this,
 * profile avatars and self-hosted covers all fell back to the generic
 * scanverse_logo, even though Discord could fetch them just fine via
 * https://scanverse.fr/uploads/...
 */
function sanitizeImage(url) {
  if (!url || typeof url !== 'string') return null;
  // http://localhost / 192.168.x.x / 10.x.x.x — Discord's CDN can't reach
  // those, so they're equivalent to "no image" from our side.
  if (/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url)) {
    return null;
  }
  if (url.startsWith('https://')) return url;
  // Promote http → https when the host is reachable on both. Discord
  // requires https specifically, so a bare http://scanverse.fr/... would
  // be rejected; rewriting is safe because every public asset is on the
  // same host with TLS.
  if (url.startsWith('http://')) {
    const isPublic = !/^http:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url);
    return isPublic ? url.replace(/^http:\/\//, 'https://') : null;
  }
  // Relative paths ("/uploads/...", "/proxy/cover/...") get the public
  // site URL prefixed. We always anchor on the prod URL — Discord can't
  // reach a localhost dev server anyway, so even in dev the right move
  // is to point at scanverse.fr (or whatever SCANVERSE_PUBLIC_URL is).
  if (url.startsWith('/')) {
    const base = SITE_URL.replace(/\/$/, '');
    if (!base.startsWith('https://')) return null; // dev base — not reachable
    return base + url;
  }
  return null;
}

/**
 * Build the buttons array for manga / reader pages.
 *
 * Discord requires a strict URI — spaces, raw unicode, or invalid chars
 * in the manga id (e.g. "s1_scans_Hunter x Hunter") would make Discord
 * reject the *entire* activity payload, breaking presence updates.
 * We URL-encode the id and validate the result with the URL constructor.
 *
 * If the manga URL is malformed, we still want SOMETHING actionable, so
 * we fall back to the generic site + Discord pair instead of returning
 * empty buttons.
 *
 * Discord caps at 2 buttons. When we have a valid manga URL, we keep
 * "Voir l'œuvre" + "Rejoindre le Discord" (drop "Ouvrir ScanVerse" since
 * the user is already on a ScanVerse page anyway).
 */
function buildMangaButton(id) {
  if (!id || typeof id !== 'string') return buildDefaultButtons();
  try {
    const url = `${SITE_URL}/manga/${encodeURIComponent(id)}`;
    new URL(url); // throws if malformed
    return [
      { label: "Voir l'œuvre", url },
      { label: 'Rejoindre le Discord', url: DISCORD_INVITE_URL },
    ];
  } catch {
    return buildDefaultButtons();
  }
}

module.exports = { getPresenceForRoute, cleanChapterLabel };

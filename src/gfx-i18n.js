/**
 * Pocket Companion — strings for the Settings tabs and the Graphics panel.
 * The locale follows navigator.language (the game has no language setting).
 */

const EN = {
  tabGeneral: 'General', tabGraphics: 'Graphics',
  quality: 'Quality', auto: 'Auto (detected: {tier})', presetHint: 'Choosing a preset clears individual overrides.',
  preset_low: 'Low', preset_balanced: 'Balanced', preset_high: 'High', preset_ultra: 'Ultra',
  renderScale: 'Render scale', fromPreset: 'From preset ({tier})',
  cat_shadows: 'Shadows', cat_ao: 'Ambient occlusion', cat_bloom: 'Bloom', cat_grade: 'Color grade',
  cat_antialias: 'Anti-aliasing', cat_reflections: 'Reflections', cat_particles: 'Particles',
  cat_detail: 'Room detail', cat_ambient: 'Ambient motion',
  tier_off: 'Off', tier_on: 'On', tier_low: 'Low', tier_medium: 'Medium', tier_high: 'High',
  tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA', tier_plain: 'Plain', tier_detailed: 'Detailed',
  adaptive: 'Adaptive resolution', adaptiveHint: 'Lowers the resolution while frames are slow, raises it again when fast.',
  showFps: 'Show frame rate',
  postUnavailable: 'Post-processing is unavailable on this device; the room is drawn without it.',
  noWebgl: '3D view unavailable — graphics settings have no effect.',
  unknownGpu: 'unknown GPU',
  w_noShadows: 'no shadows', w_shadows: '{n}² shadows', w_ao: 'ambient occlusion', w_aoFull: 'full ambient occlusion',
  w_bloom: 'bloom', w_reflections: 'reflections', w_noAA: 'no anti-aliasing',
};

const STRINGS = {
  'en-US': EN,
  'en-GB': { ...EN, cat_grade: 'Colour grade' },
  'es-419': {
    tabGeneral: 'General', tabGraphics: 'Gráficos',
    quality: 'Calidad', auto: 'Automática (detectada: {tier})', presetHint: 'Elegir un ajuste predefinido borra los cambios individuales.',
    preset_low: 'Baja', preset_balanced: 'Equilibrada', preset_high: 'Alta', preset_ultra: 'Ultra',
    renderScale: 'Escala de renderizado', fromPreset: 'Del ajuste ({tier})',
    cat_shadows: 'Sombras', cat_ao: 'Oclusión ambiental', cat_bloom: 'Resplandor', cat_grade: 'Corrección de color',
    cat_antialias: 'Antialiasing', cat_reflections: 'Reflejos', cat_particles: 'Partículas',
    cat_detail: 'Detalle de la habitación', cat_ambient: 'Movimiento ambiental',
    tier_off: 'Desactivado', tier_on: 'Activado', tier_low: 'Bajo', tier_medium: 'Medio', tier_high: 'Alto',
    tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA', tier_plain: 'Simple', tier_detailed: 'Detallado',
    adaptive: 'Resolución adaptable', adaptiveHint: 'Baja la resolución cuando los cuadros van lentos y la sube cuando van rápido.',
    showFps: 'Mostrar cuadros por segundo',
    postUnavailable: 'El posprocesado no está disponible en este dispositivo; la habitación se dibuja sin él.',
    noWebgl: 'Vista 3D no disponible: los ajustes gráficos no tienen efecto.',
    unknownGpu: 'GPU desconocida',
    w_noShadows: 'sin sombras', w_shadows: 'sombras {n}²', w_ao: 'oclusión ambiental', w_aoFull: 'oclusión ambiental completa',
    w_bloom: 'resplandor', w_reflections: 'reflejos', w_noAA: 'sin antialiasing',
  },
  'de-DE': {
    tabGeneral: 'Allgemein', tabGraphics: 'Grafik',
    quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})', presetHint: 'Eine Voreinstellung setzt einzelne Anpassungen zurück.',
    preset_low: 'Niedrig', preset_balanced: 'Ausgewogen', preset_high: 'Hoch', preset_ultra: 'Ultra',
    renderScale: 'Renderskalierung', fromPreset: 'Aus Voreinstellung ({tier})',
    cat_shadows: 'Schatten', cat_ao: 'Umgebungsverdeckung', cat_bloom: 'Leuchteffekt', cat_grade: 'Farbkorrektur',
    cat_antialias: 'Kantenglättung', cat_reflections: 'Spiegelungen', cat_particles: 'Partikel',
    cat_detail: 'Raumdetails', cat_ambient: 'Umgebungsbewegung',
    tier_off: 'Aus', tier_on: 'An', tier_low: 'Niedrig', tier_medium: 'Mittel', tier_high: 'Hoch',
    tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA', tier_plain: 'Schlicht', tier_detailed: 'Detailliert',
    adaptive: 'Adaptive Auflösung', adaptiveHint: 'Senkt die Auflösung bei langsamen Bildern und hebt sie bei schnellen wieder an.',
    showFps: 'Bildrate anzeigen',
    postUnavailable: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; der Raum wird ohne sie gezeichnet.',
    noWebgl: '3D-Ansicht nicht verfügbar – Grafikeinstellungen haben keine Wirkung.',
    unknownGpu: 'unbekannte GPU',
    w_noShadows: 'keine Schatten', w_shadows: '{n}²-Schatten', w_ao: 'Umgebungsverdeckung', w_aoFull: 'volle Umgebungsverdeckung',
    w_bloom: 'Leuchteffekt', w_reflections: 'Spiegelungen', w_noAA: 'keine Kantenglättung',
  },
  'fr-FR': {
    tabGeneral: 'Général', tabGraphics: 'Graphismes',
    quality: 'Qualité', auto: 'Auto (détectée : {tier})', presetHint: 'Choisir un préréglage efface les réglages individuels.',
    preset_low: 'Basse', preset_balanced: 'Équilibrée', preset_high: 'Haute', preset_ultra: 'Ultra',
    renderScale: 'Échelle de rendu', fromPreset: 'Du préréglage ({tier})',
    cat_shadows: 'Ombres', cat_ao: 'Occlusion ambiante', cat_bloom: 'Halo lumineux', cat_grade: 'Étalonnage des couleurs',
    cat_antialias: 'Anticrénelage', cat_reflections: 'Reflets', cat_particles: 'Particules',
    cat_detail: 'Détails de la pièce', cat_ambient: 'Mouvement ambiant',
    tier_off: 'Désactivé', tier_on: 'Activé', tier_low: 'Bas', tier_medium: 'Moyen', tier_high: 'Élevé',
    tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA', tier_plain: 'Simple', tier_detailed: 'Détaillé',
    adaptive: 'Résolution adaptative', adaptiveHint: 'Réduit la résolution quand les images ralentissent, puis la rétablit.',
    showFps: 'Afficher les images par seconde',
    postUnavailable: 'Le post-traitement n’est pas disponible sur cet appareil ; la pièce est dessinée sans lui.',
    noWebgl: 'Vue 3D indisponible : les réglages graphiques sont sans effet.',
    unknownGpu: 'GPU inconnu',
    w_noShadows: 'sans ombres', w_shadows: 'ombres {n}²', w_ao: 'occlusion ambiante', w_aoFull: 'occlusion ambiante complète',
    w_bloom: 'halo', w_reflections: 'reflets', w_noAA: 'sans anticrénelage',
  },
  'pt-BR': {
    tabGeneral: 'Geral', tabGraphics: 'Gráficos',
    quality: 'Qualidade', auto: 'Automática (detectada: {tier})', presetHint: 'Escolher uma predefinição limpa os ajustes individuais.',
    preset_low: 'Baixa', preset_balanced: 'Equilibrada', preset_high: 'Alta', preset_ultra: 'Ultra',
    renderScale: 'Escala de renderização', fromPreset: 'Da predefinição ({tier})',
    cat_shadows: 'Sombras', cat_ao: 'Oclusão ambiente', cat_bloom: 'Brilho', cat_grade: 'Correção de cor',
    cat_antialias: 'Antisserrilhamento', cat_reflections: 'Reflexos', cat_particles: 'Partículas',
    cat_detail: 'Detalhes do quarto', cat_ambient: 'Movimento ambiente',
    tier_off: 'Desligado', tier_on: 'Ligado', tier_low: 'Baixo', tier_medium: 'Médio', tier_high: 'Alto',
    tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA', tier_plain: 'Simples', tier_detailed: 'Detalhado',
    adaptive: 'Resolução adaptável', adaptiveHint: 'Reduz a resolução quando os quadros ficam lentos e aumenta quando ficam rápidos.',
    showFps: 'Mostrar taxa de quadros',
    postUnavailable: 'O pós-processamento não está disponível neste dispositivo; o quarto é desenhado sem ele.',
    noWebgl: 'Visão 3D indisponível — as configurações gráficas não têm efeito.',
    unknownGpu: 'GPU desconhecida',
    w_noShadows: 'sem sombras', w_shadows: 'sombras {n}²', w_ao: 'oclusão ambiente', w_aoFull: 'oclusão ambiente completa',
    w_bloom: 'brilho', w_reflections: 'reflexos', w_noAA: 'sem antisserrilhamento',
  },
  'it-IT': {
    tabGeneral: 'Generali', tabGraphics: 'Grafica',
    quality: 'Qualità', auto: 'Automatica (rilevata: {tier})', presetHint: 'Scegliere una preimpostazione azzera le modifiche singole.',
    preset_low: 'Bassa', preset_balanced: 'Bilanciata', preset_high: 'Alta', preset_ultra: 'Ultra',
    renderScale: 'Scala di rendering', fromPreset: 'Dalla preimpostazione ({tier})',
    cat_shadows: 'Ombre', cat_ao: 'Occlusione ambientale', cat_bloom: 'Bagliore', cat_grade: 'Correzione colore',
    cat_antialias: 'Anti-aliasing', cat_reflections: 'Riflessi', cat_particles: 'Particelle',
    cat_detail: 'Dettagli della stanza', cat_ambient: 'Movimento ambientale',
    tier_off: 'No', tier_on: 'Sì', tier_low: 'Basso', tier_medium: 'Medio', tier_high: 'Alto',
    tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA', tier_plain: 'Semplice', tier_detailed: 'Dettagliato',
    adaptive: 'Risoluzione adattiva', adaptiveHint: 'Abbassa la risoluzione quando i fotogrammi rallentano e la rialza quando tornano veloci.',
    showFps: 'Mostra fotogrammi al secondo',
    postUnavailable: 'La post-elaborazione non è disponibile su questo dispositivo; la stanza viene disegnata senza.',
    noWebgl: 'Vista 3D non disponibile: le impostazioni grafiche non hanno effetto.',
    unknownGpu: 'GPU sconosciuta',
    w_noShadows: 'senza ombre', w_shadows: 'ombre {n}²', w_ao: 'occlusione ambientale', w_aoFull: 'occlusione ambientale completa',
    w_bloom: 'bagliore', w_reflections: 'riflessi', w_noAA: 'senza anti-aliasing',
  },
};
STRINGS['es-ES'] = {
  ...STRINGS['es-419'],
  quality: 'Calidad', auto: 'Automática (detectada: {tier})',
  cat_antialias: 'Suavizado de bordes', w_noAA: 'sin suavizado',
  adaptiveHint: 'Baja la resolución cuando los fotogramas van lentos y la sube cuando van rápidos.',
  showFps: 'Mostrar fotogramas por segundo',
};
STRINGS['fr-CA'] = {
  ...STRINGS['fr-FR'],
  showFps: 'Afficher le nombre d’images par seconde',
  cat_bloom: 'Éclat lumineux', w_bloom: 'éclat',
};

export const GFX_LOCALES = Object.keys(STRINGS);

/** Pick the closest supported locale for a BCP-47 tag. */
export function pickLocale(tag) {
  const t = String(tag || 'en-US');
  const exact = GFX_LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const [lang, region = ''] = t.toLowerCase().split('-');
  if (lang === 'en') return ['gb', 'uk', 'au', 'nz', 'ie', 'za', 'in'].includes(region) ? 'en-GB' : 'en-US';
  if (lang === 'es') return region === 'es' || region === '' ? 'es-ES' : 'es-419';
  if (lang === 'fr') return region === 'ca' ? 'fr-CA' : 'fr-FR';
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'de') return 'de-DE';
  if (lang === 'it') return 'it-IT';
  return 'en-US';
}

/** Translator for a locale: t(key, {vars}). Falls back to US English. */
export function gfxStrings(tag) {
  const table = STRINGS[pickLocale(tag)];
  return (key, vars = {}) => {
    const s = table[key] ?? EN[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  };
}

/** Words for gfx.describe() in the given translator. */
export function describeWords(t) {
  return {
    noShadows: t('w_noShadows'), shadows: t('w_shadows', { n: '{n}' }), ao: t('w_ao'), aoFull: t('w_aoFull'),
    bloom: t('w_bloom'), reflections: t('w_reflections'), noAA: t('w_noAA'),
  };
}

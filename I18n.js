.pragma library

// Shared, deliberately.
//
// Without `.pragma library` every QML file that imports a .js resource gets its
// OWN copy of it: Service.qml would switch the language on its instance and the
// settings pane would keep rendering from an untouched one. The symptom is a
// setting that visibly does nothing, with every individual piece working when
// tested on its own.

// Strings, in one place.
//
// English is the default and the fallback: an untranslated key shows the
// English rather than the key itself, because a pane reading "row.palette" is
// worse than one reading it in the wrong language.
//
// Rules that keep this honest:
//   - No sentence is assembled by concatenating translated fragments. Word
//     order is not universal, and a table of fragments cannot express that.
//     Anything with a value in it is a template with a placeholder.
//   - No flags. A flag is a country, and a language is not.
//   - The setting *values* — `bottom`, `mirror`, `rainbow` — are translated
//     too. They are words the pane shows, not identifiers the user typed.

var LANGUAGE = "en"

var STRINGS = {
  en: {
    "widget.tooltip": "{base} · {palette} · click to open",

    "idle.missing": "cava is not installed",
    "idle.missingFix": "omarchy pkg add cava",
    "idle.battery": "paused on battery",
    "idle.silent": "nothing playing",

    "hint.settings": "s  settings",
    "hint.close": "esc  close",
    "hint.reverse": "shift  goes back",

    "settings.title": "Settings",
    "settings.help": "click a value or press its letter · right button and shift go back",
    "settings.themed": "theme",

    "row.base": "base",
    "row.cap": "cap",
    "row.fill": "fill",
    "row.palette": "palette",
    "row.input": "input",
    "row.showPeaks": "peak",
    "row.showWave": "wave",
    "row.barCount": "bars",
    "row.smoothing": "fall",
    "row.framerate": "fps",
    "row.language": "language",
    "row.gradientFrom": "gradient from",
    "row.gradientTo": "gradient to",
    "row.solidColor": "colour",

    "base.bottom": "bottom",
    "base.top": "top",
    "base.mirror": "mirror",
    "base.radial": "radial",

    "cap.flat": "flat",
    "cap.round": "round",
    "cap.segments": "segments",

    "fill.solid": "solid",
    "fill.barGradient": "per bar",
    "fill.screenGradient": "across",

    "palette.accent": "accent",
    "palette.foreground": "foreground",
    "palette.intensity": "intensity",
    "palette.spectrum": "spectrum",
    "palette.rainbow": "rainbow",
    "palette.heat": "heat",
    "palette.gradient": "gradient",
    "palette.solid": "one colour",
    "palette.urgent": "urgent",

    "input.system": "system",
    "input.mic": "microphone",
    "input.both": "both",

    "language.auto": "auto",
    "language.en": "English",
    "language.pt": "Português",

    "bool.true": "on",
    "bool.false": "off"
  },

  pt: {
    "widget.tooltip": "{base} · {palette} · clique para abrir",

    "idle.missing": "cava não está instalado",
    "idle.missingFix": "omarchy pkg add cava",
    "idle.battery": "pausado na bateria",
    "idle.silent": "nada tocando",

    "hint.settings": "s  ajustes",
    "hint.close": "esc  fechar",
    "hint.reverse": "shift  volta",

    "settings.title": "Ajustes",
    "settings.help": "clique num valor ou aperte a letra · botão direito e shift voltam",
    "settings.themed": "tema",

    "row.base": "base",
    "row.cap": "ponta",
    "row.fill": "preenchimento",
    "row.palette": "paleta",
    "row.input": "entrada",
    "row.showPeaks": "pico",
    "row.showWave": "onda",
    "row.barCount": "barras",
    "row.smoothing": "queda",
    "row.framerate": "fps",
    "row.language": "idioma",
    "row.gradientFrom": "gradiente de",
    "row.gradientTo": "gradiente até",
    "row.solidColor": "cor",

    "base.bottom": "de baixo",
    "base.top": "de cima",
    "base.mirror": "espelho",
    "base.radial": "radial",

    "cap.flat": "reta",
    "cap.round": "arredondada",
    "cap.segments": "segmentos",

    "fill.solid": "sólido",
    "fill.barGradient": "por barra",
    "fill.screenGradient": "atravessa",

    "palette.accent": "destaque",
    "palette.foreground": "texto",
    "palette.intensity": "intensidade",
    "palette.spectrum": "espectro",
    "palette.rainbow": "arco-íris",
    "palette.heat": "calor",
    "palette.gradient": "gradiente",
    "palette.solid": "uma cor",
    "palette.urgent": "urgente",

    "input.system": "sistema",
    "input.mic": "microfone",
    "input.both": "ambos",

    "language.auto": "automático",
    "language.en": "English",
    "language.pt": "Português",

    "bool.true": "sim",
    "bool.false": "não"
  }
}

function setLanguage(name) {
  LANGUAGE = STRINGS[name] ? name : "en"
  return LANGUAGE
}

// `auto` follows the environment, and falls back to English for anything not
// translated rather than guessing at a near neighbour.
function detectLanguage(locale) {
  var tag = String(locale || "").toLowerCase()
  if (tag.indexOf("pt") === 0) return "pt"
  return "en"
}

function language() {
  return LANGUAGE
}

// An untranslated key shows the English, not the key.
function t(key, values) {
  var table = STRINGS[LANGUAGE] || STRINGS.en
  var text = table[key]
  if (text === undefined) text = STRINGS.en[key]
  if (text === undefined) return key

  if (!values) return text

  return text.replace(/\{(\w+)\}/g, function(match, name) {
    return values[name] === undefined ? match : String(values[name])
  })
}

// A setting's value, said in words. Booleans and numbers pass through as
// themselves: "24" is not a word anyone needs translated, and inventing a key
// per number would be a table nobody could keep in step with the value list.
function value(row, raw) {
  if (raw === true) return t("bool.true")
  if (raw === false) return t("bool.false")
  if (typeof raw === "number") return String(raw)
  return t(row + "." + raw)
}

// The whole idle message, so the fix line stays attached to the reason it
// belongs to rather than being stitched together at the call site.
function idleText(reason) {
  if (reason === "missing") return t("idle.missing") + "\n" + t("idle.missingFix")
  if (reason === "battery") return t("idle.battery")
  if (reason === "silent") return t("idle.silent")
  return ""
}

// With the pane open the letters on screen are the instructions, so the hint
// only has to say the one thing they cannot show: that shift reverses them.
function hintText(settingsOpen) {
  var parts = [t("hint.settings"), t("hint.close")]
  if (settingsOpen) parts.unshift(t("hint.reverse"))
  return parts.join("     ")
}

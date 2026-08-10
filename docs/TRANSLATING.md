# Translating ByteTable

ByteTable's interface can be translated into any language. **Only the interface
is translated** — schema names, table and column identifiers, cell values, SQL /
CQL / Cypher and engine responses are never rewritten. If you find a translation
that changes any of those, that's a bug.

Every string lives in `src/shared/i18n/`. English (`strings/en.ts`) is the source
of truth: a key missing from your language falls back to English and lowers that
language's coverage percentage in Settings → Language & region. **A partial
translation is welcome** — it is a number in the picker, not a failure.

## Improving an existing language

One file: `src/shared/i18n/strings/<code>.ts`. Add or fix entries, keep the keys
exactly as they appear in `en.ts`, open a PR. That's the whole job.

## Adding a new language

Three files.

**1. `src/shared/i18n/strings/<code>.ts`** — copy `en.ts` as a starting point and
translate what you can:

```ts
import type { StringTable } from "./en";

export const ptBR: StringTable = {
  "common.save": "Salvar",
  // …
};
```

**2. `src/shared/i18n/strings/index.ts`** — register it in `STRINGS`.

**3. `src/shared/i18n/locales.ts`** — add a `LOCALES` entry:

```ts
"pt-BR": { name: "Portuguese (Brazil)", endonym: "Português", dir: "ltr", region: "pt-BR" },
```

- `endonym` — the language's own name for itself. It is what the picker shows
  first, so write it the way a native reader expects to see it.
- `dir` — `"rtl"` for right-to-left scripts (Arabic, Hebrew, Persian, Urdu). The
  whole shell mirrors automatically; code, SQL, JSON and grid cells stay
  left-to-right.
- `region` — the default BCP-47 tag used for dates and numbers when the user
  leaves the region setting on "Follow language".
- `script` / `google` — only for a non-Latin script, e.g.
  `script: "'Noto Sans Devanagari'"` with
  `google: "Noto+Sans+Devanagari:wght@400;500;600"`. The font is fetched the
  first time that language is selected; Latin languages load nothing.

Nothing else needs touching: the picker, the coverage bar and the settings
contract all read the catalog.

## Rules that keep translations safe

- **One key per user-visible string.** Never build a sentence by concatenating
  keys — word order differs per language.
- **Parameterize instead.** `{name}` interpolates a value;
  `{count, plural, one {# row} other {# rows}}` picks a form through
  `Intl.PluralRules` for your language. Use every category your language needs
  (Arabic has six: `zero`, `one`, `two`, `few`, `many`, `other`); languages with
  a single form can just write `{count} …`.
- **Leave the machine parts alone.** SQL and engine keywords, identifiers, HTTP
  verbs, header names, units and file extensions are API surface, not copy.
- **Watch the length.** German is the longest, CJK the tallest. Check the
  settings nav, the segmented controls and the connect-screen buttons at a
  1280px-wide window before opening the PR.

## Checking your work

```sh
pnpm dev        # switch language in Settings → Language & region, live
pnpm typecheck  # catches a key that does not exist in en.ts
pnpm lint
```

Translations ship in the next release — they are compiled into the app, so there
is no way to load one without a build today.

## Reviewing

Machine translation is a fine first pass, but a language is only shipped once a
speaker has read it. Say in your PR which it is: a reviewed translation and an
unreviewed one are held to different bars, and users are told when a language is
a community translation.

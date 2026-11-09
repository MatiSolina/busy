# Bot avatars

The identity picker offers six styles in one grid: Classic, Disco, Pop, Punk,
Nerd and Gamer. Selecting a costume starts with its preset color; choosing a
color keeps the costume. Classic removes the costume while keeping the current
color. Existing Chef identities remain supported, including color changes,
but Chef is no longer offered as a new style choice.

The existing `bots.avatar` text column stores the selection. Classic identities
remain plain color names. Costumes use `pix:<variant>:<color>`, for example
`pix:pop:orange`. This fits the existing 40-character API limit and needs no
database migration or bot redeployment.

`variantFor()` recognizes only known costumes and valid colors in that exact
format. Previous icon-coded avatars, unknown values and missing values keep
their existing color/hash fallback. `PIX_KEYS` must retain its order so legacy
bots keep their colors.

`PixCostume` renders the layers as SVG inside the existing motion wrapper. All
styles share the classic viewBox so heads keep the same scale. Hair and
accessories can extend beyond it through visible SVG overflow. The classic
working eye geometry, gaze, external eye refs and reduced-motion behavior
remain intact.

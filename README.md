# Coder Training

An open-source web app for training content-analysis coders. A trainer uploads
a codebook and a text dataset. Coders join with a session code, code the same
batch independently (blind), then review disagreements and reliability
together before the next round.

- Static site (vanilla JavaScript, built with Vite), hosted free on GitHub Pages
- Supabase free tier for the database and sign-in
- All permissions are enforced in the database with Row Level Security, so
  blind coding does not depend on the web page behaving

**To run your own copy, follow [SETUP.md](SETUP.md).** No programming needed.

## Build status

| Step | What it covers | Status |
|---|---|---|
| 1 | Trainer sign-in, sessions, dataset upload, codebook editor, settings | Done |
| 2 | Coder join and rejoin, blind coding view, progress dashboard | Done |
| 3 | Close round, agreement and Krippendorff's alpha, disagreement review | Done |
| 4 | Next round, reliability over rounds, CSV exports | Next |

The database script (`supabase/setup.sql`) already covers all four steps.

## How it is organized

| Path | What it is |
|---|---|
| `src/config.js` | The two Supabase values you paste in. The only file to edit. |
| `supabase/setup.sql` | Tables, security policies, and functions. Paste into Supabase once. |
| `src/pages/` | One file per screen |
| `src/lib/` | Codebook and dataset logic, no screen code |
| `sample/` | A 60-post sample dataset and a 3-variable codebook (JSON includes worked examples) |
| `tests/` | Automated tests, including the security rules run against a real Postgres engine |

## Codebook layout

Every variable uses the same four parts:

| Part | What goes in it | Required |
|---|---|---|
| Name | For example "Stance" | Yes |
| Instructions | Rules for the whole variable: what to look at, decision rules, tie-breakers | No |
| Categories | Each with a label, a definition, and short example phrases | At least two |
| Worked examples | Full items with the correct code and the reason | No |

Type the codebook into the editor, or import it. JSON carries everything.
CSV (one row per category) carries everything except worked examples.

## Reliability statistics

Computed per variable when the trainer closes a round (`src/lib/alpha.js`):

- **Krippendorff's alpha** for nominal data, any number of coders, missing
  codes allowed. Items coded by fewer than two coders are left out.
- **Pairwise agreement**: of all pairs of coders who coded the same item, the
  share that chose the same category.
- **Items all agreed**: items where every coder who coded it chose the same category.

Alpha is tested against the worked examples in Krippendorff (2011),
"Computing Krippendorff's Alpha-Reliability" (.095, .692, .743), the
Wikipedia worked example (.691), and 40 random tables computed with R's
`irr` package.

One difference from `irr` to be aware of: for tables with no missing codes
and three or more coders, `irr::kripp.alpha` (version 0.85) returns a
slightly different value than Krippendorff's formula (for example .697
instead of .702). This app follows Krippendorff's formula. With two coders,
or with any missing code, the two agree exactly.

## Roles

- **Trainers** sign in with an email link and can return to their sessions.
- **Coders** have no accounts. They enter a session code and get a letter
  and their name, and get a letter (A, B, C...) plus a personal rejoin code
  for switching devices. Only the trainer can see names.
- The trainer cannot see anyone's codes until they close the round, so a
  trainer can also join their own session as a coder.

## For developers

```
npm install
npm run dev     # local site at http://localhost:5173
npm test        # unit tests + database security tests (in-memory Postgres)
npm run build   # production build in dist/
```

## License

MIT

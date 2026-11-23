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
| 2 | Coder join and rejoin, blind coding view, progress dashboard | Next |
| 3 | Close round, agreement and Krippendorff's alpha, disagreement review | Planned |
| 4 | Next round, reliability over rounds, CSV exports | Planned |

The database script (`supabase/setup.sql`) already covers all four steps.

## How it is organized

| Path | What it is |
|---|---|
| `src/config.js` | The two Supabase values you paste in. The only file to edit. |
| `supabase/setup.sql` | Tables, security policies, and functions. Paste into Supabase once. |
| `src/pages/` | One file per screen |
| `src/lib/` | Codebook and dataset logic, no screen code |
| `sample/` | A 60-post sample dataset and a 3-variable codebook for trying it out |
| `tests/` | Automated tests, including the security rules run against a real Postgres engine |

## Roles

- **Trainers** sign in with an email link and can return to their sessions.
- **Coders** have no accounts. They enter a session code and get a letter
  (A, B, C...) plus a personal rejoin code for switching devices. Names are
  optional and only the trainer can see them.
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

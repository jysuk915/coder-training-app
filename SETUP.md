# Setup guide

This guide gets your own copy of the app running. It takes about 30 minutes
and needs no programming. Everything used here is free.

You will end up with:

- a website address like `https://YOUR-NAME.github.io/coder-training-app/`
- a private database that only your copy of the app talks to

## Step 1. Create two accounts

1. **GitHub** (hosts the website): sign up at <https://github.com/signup>.
2. **Supabase** (hosts the database): sign up at <https://supabase.com/dashboard>.
   Signing in with your GitHub account is the quickest way.

## Step 2. Copy the app into your GitHub account

1. Open the app's GitHub page and click **Fork** (top right), then **Create fork**.
2. You now have your own copy at `github.com/YOUR-NAME/coder-training-app`.

## Step 3. Create the database

1. In Supabase, click **New project**. Give it a name, set a database
   password (save it somewhere; you will not need it for this guide), choose
   the region closest to you, and click **Create new project**. Wait a minute
   or two for it to finish.
2. In the left menu open **SQL Editor**.
3. In your GitHub copy, open `supabase/setup.sql`, click the **Copy raw file**
   button, paste everything into the SQL editor, and click **Run**.
   You should see "Success. No rows returned."
4. In the left menu open **Authentication**, then **Sign In / Providers**.
   Turn on **Allow anonymous sign-ins** and save. This is how coders join
   without accounts. Leave **Email** turned on (it is by default); trainers
   use it.

## Step 4. Connect the app to the database (2 keys)

1. In Supabase open **Project Settings**, then **API Keys** (on some projects
   the page is called **API**). Find:
   - the **Project URL**, which looks like `https://abcdefgh.supabase.co`
     (if it is not on that page, it is under **Project Settings > Data API**)
   - the **publishable** key (older projects call it the **anon public** key)
2. In your GitHub copy open `src/config.js` and click the pencil icon to edit.
3. Replace the two placeholder values with yours, keeping the quote marks:

   ```js
   export const SUPABASE_URL = 'https://abcdefgh.supabase.co';
   export const SUPABASE_ANON_KEY = 'sb_publishable_...';
   ```

4. Click **Commit changes**.

These two values are meant to be public. Never paste the **secret** or
**service_role** key anywhere in this project.

## Step 5. Publish the website

1. In your GitHub copy open **Settings**, then **Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Open the **Actions** tab. If GitHub asks, click **I understand my
   workflows, go ahead and enable them**.
4. Click **Deploy to GitHub Pages** on the left, then **Run workflow**.
   After about two minutes a green check appears.
5. Your site is at `https://YOUR-NAME.github.io/coder-training-app/`.

From now on, every change you commit republishes the site automatically.

## Step 6. Tell Supabase where your website lives

Sign-in links are only sent back to addresses you approve.

1. In Supabase open **Authentication**, then **URL Configuration**.
2. Set **Site URL** to your website address from step 5, including the final `/`.
3. Under **Redirect URLs** add the same address, and save.

## Step 7. Try it

1. Open your website and click **Trainer sign-in**. Enter your email, then
   open the link that arrives, in the same browser.
2. Create a session.
3. On the **Dataset** tab upload `sample/sample_dataset.csv` (download it from
   your GitHub copy first). Confirm the ID and text columns, then upload.
4. On the **Codebook** tab click **Import CSV or JSON** and choose
   `sample/sample_codebook.json`, then **Save**.
5. On the **Settings** tab set the batch size (20 gives three rounds with the
   sample data) and the reliability target.
6. On the **Rounds and coders** tab click **Start round 1**.
7. Try being a coder. Copy the join link from the same tab and open it in a
   different browser, or in a private/incognito window, so it does not share
   your trainer sign-in. Enter a name, save the rejoin code you are shown,
   and code a few items.
8. Back in your trainer window, the **Rounds and coders** tab shows that
   coder's progress. You can also click **Join as a coder myself** to code in
   your own session.
9. With at least two coders done, click **Close round 1**. The review opens:
   reliability per variable, the disagreement cards, and the codebook issues
   list. Coders reach the same review from their own page.

## Good to know

**Sign-in emails for other trainers.** Supabase's built-in email service is
for testing: it sends only a few emails per hour, and only to people who are
members of your Supabase organization. That is enough if you are the only
trainer. To let colleagues sign in as trainers, either invite them to your
Supabase organization (Organization settings, Team), or connect a free email
service such as Resend under **Authentication > Emails > SMTP Settings**.
Coders are not affected, because they never receive email.

**Free projects pause when idle.** Supabase pauses a free project after about
a week without activity. Nothing is lost. Open the Supabase dashboard and
click **Restore project** before your next session.

**Free-tier size.** The free database holds 500 MB, which is far more than
text coding projects need.

**Research ethics.** Your data is stored on Supabase's servers in the region
you chose. Check your institution's rules for cloud storage before uploading
anything sensitive or identifiable.

**Updating later.** When the app gets new features, click **Sync fork** on
your GitHub copy. If the update notes say the database changed, paste the new
`supabase/setup.sql` into the SQL editor and run it again. It is safe to rerun
and does not delete your data.

## Testing on your own computer (optional)

If you have [Node.js](https://nodejs.org) installed:

```
npm install
npm run dev
```

Then open <http://localhost:5173>. Add `http://localhost:5173` to the
Redirect URLs in step 6 so sign-in links work locally.

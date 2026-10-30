# Re-publishing on Greasy Fork

Everything you need is in this folder:

| File | Where it goes |
|---|---|
| `additional-info.md` | Paste into **Default additional info** on the script's Admin page, with **Markdown** selected |
| `description.txt` | The one-line description. It is already the `@description` line in the script, so it fills in by itself; this copy is for reference |
| the script | `https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/bookfunnel-downloader.user.js` |

## 1. Hide the old page (reversible)

1. Open <https://greasyfork.org/en/scripts/602430/delete> (signed in as MankeyDoodle).
2. Choose **"They will keep it as it is."** and click **Delete**.
   This is a soft delete: you can undelete it at any time. Do not use
   "Permanent deletion" unless the import in step 2 is refused.

## 2. Import the script from GitHub

1. Make sure the latest commit is pushed to GitHub first (Greasy Fork reads `main`).
2. Open <https://greasyfork.org/en/import>.
3. Paste the raw URL from the table above.
4. Choose **Automatic** syncing and import.
   - Version `1.0.0` is accepted because this is a new script.
   - If it says the script is a duplicate or the name is taken, stop and read
     the message. It can mean the soft-deleted copy still counts; then use
     "Permanent deletion" on the old page (7-day countdown, cancellable) or
     ask on the Greasy Fork forum.

## 3. Add the page text

1. Open the new script's **Admin** tab.
2. Under **Default additional info**, select **Markdown**.
3. Paste all of `additional-info.md`, then press **Preview** to check the
   pictures load, then save.

## 4. Optional: update on every push

On the Admin tab click **"set up a webhook"** and copy the Webhook URL and secret.
On GitHub, signed in as MankeyDoodle: the repo's **Settings, Webhooks, Add webhook**.
Paste both, choose **Just the push event** and content type `application/json`.

Greasy Fork only accepts an update when `@version` goes up, so bump it in the
script header before pushing a change. Do not add `@updateURL` or `@downloadURL`
pointing at GitHub: Greasy Fork rejects them.

## 5. Tell me the new link

The README still links the old script page (602430). Send me the new address and
the README gets fixed.

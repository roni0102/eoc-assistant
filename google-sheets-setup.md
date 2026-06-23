# Record leads in a Google Sheet (free, no API keys)

Every new sign-up (Company, Email, Phone) gets added as a row to a Google Sheet on your
Drive — automatically, in real time. This also makes your leads **permanent** (they no
longer reset when the site updates).

## 1. Create the sheet
1. Go to **sheets.google.com** → **Blank spreadsheet**.
2. Name it (top-left), e.g. **EOC Leads**.

## 2. Add the script
1. In the sheet: menu **Extensions → Apps Script**.
2. Delete whatever code is shown, and paste this in:

```javascript
function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheets()[0];
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Date', 'Company', 'Email', 'Phone', 'Tier']);
    }
    var d = JSON.parse(e.postData.contents);
    sheet.appendRow([
      d.ts ? new Date(d.ts) : new Date(),
      d.company || '',
      d.email || '',
      d.phone || '',
      d.tier || 'free'
    ]);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

3. Click the **Save** icon (💾).

## 3. Publish it as a web app
1. Top-right: **Deploy → New deployment**.
2. Click the gear ⚙ next to "Select type" → choose **Web app**.
3. Set:
   - **Execute as:** *Me*
   - **Who has access:** *Anyone*
4. Click **Deploy**.
5. Google asks you to **Authorize access** → pick your account → on the "Google hasn't
   verified this app" screen click **Advanced → Go to (your project)** → **Allow**.
   *(This is safe — it's your own script running on your own sheet.)*
6. Copy the **Web app URL** it shows (looks like
   `https://script.google.com/macros/s/AKfy…/exec`).

## 4. Give the URL to the site
In **Render → your eoc-assistant service → Environment**, add a new variable:
- **Key:** `SHEETS_WEBHOOK_URL`
- **Value:** the Web app URL you just copied

**Save Changes** → Render redeploys (~2 min). Done — new sign-ups now appear in your sheet.

---
**Notes**
- Existing leads already captured aren't back-filled — only sign-ups from now on.
- If you ever change the script, you must **Deploy → Manage deployments → Edit → New version**
  for the change to take effect (the `/exec` URL stays the same).
- The site still also keeps its own copy and the CSV export; the sheet is an added mirror.

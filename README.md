# Midey — Gmail Lead Dispatcher (Chrome Extension - Manifest V3)

A Chrome extension built for **Midey** to send personalized cold emails, partnership pitches, and follow-ups directly through your logged-in Gmail web app (`https://mail.google.com/`). Supports **JSON Arrays**, **CSV Upload/Paste with Personalization Tags**, **Rotating Signatures**, **Light/Dark Themes**, and both **In-Page Manual Review** and **Full Automated Queue Dispatch**.

---

## 🚀 Quick Setup (Load Unpacked in Chrome)

1. Open Google Chrome on your PC.
2. Navigate to:
   ```text
   chrome://extensions/
   ```
3. Toggle on **Developer mode** in the top-right corner.
4. Click the **Load unpacked** button in the top-left corner.
5. Select the folder:
   ```text
   /home/midey/Music/Scount New/gmail-json-sender
   ```
6. The **Midey** extension icon (`M`) will appear in your Chrome extensions toolbar! Pin it for quick access.

---

## 🎨 New Features in Version 1.1

### 1. Cryptographic Security Gate & Secret Developer Unlock
- **First-Run Installation Activation Lock**:
  - Anyone installing the extension is presented with a full-screen cryptographic activation lock screen.
  - The extension is protected with **PBKDF2-SHA256 (100,000 iterations + cryptographically strong salt)**, which means the master password is never stored in plain text anywhere in the files.
  - Inspecting the code or passing the files to an AI model cannot recover or reverse-engineer the password.
  - The header includes a **🔒 Lock** button allowing you to re-lock the extension workspace at any time.
- **Hidden Developer JSON Mode**:
  - By default, **CSV Import is the primary, default mode**. The JSON Array tab is completely hidden to keep the interface clean and protect raw code settings.
  - To reveal and unlock the JSON mode: Click on the **Midey** brand name/logo in the top header.
  - Enter the master security password in the authorization prompt modal.
  - Inside the unlocked JSON tab, you can toggle **"Keep unlocked across sessions"** so it stays visible even after switching tabs or closing the window, or click **"Lock & Hide"** to re-secure it immediately.

### 2. Global Counter & Analytical Board (Top Header)
Directly beneath the header is an all-in-one dispatch performance dashboard:
- **Today's Sent Volume**: Shows real-time dispatched count for today.
- **Rolling 7-Day Performance Record**: Aggregates all emails dispatched over the past 7 days, complete with interactive day chips showing daily volume.
- **Lifetime Dispatched Record**: Historical all-time counter tracking total successful sends.
- **Password-Protected Reset Button**: Click **Reset Stats** to clear records. Demands the master authorization password before resetting counters.
- **Collapsible & Customizable**: Can be collapsed with the chevron or toggled in the Layout settings.

### 3. Light & Dark Theme Toggle
- Click the **☀️ Light / 🌙 Dark** button in the header anytime to toggle themes.
- Preferences are saved in `chrome.storage.local` and seamlessly applied whether you are using the popup or the docked Chrome Side Panel.

### 4. CSV File Upload & Paste with Personalization Tags (Default Mode)
- **Drag & Drop or Upload**: Upload any `.csv` file directly.
- **Paste Raw CSV**: Or paste raw spreadsheet text directly into the box.
- **Automatic Header Detection**: Automatically detects column names like `name`, `company`, `url`, `country`, `role`, etc.
- **Dynamic Personalization Tags**:
  - Click any detected tag chip (e.g. `{name}`, `{company}`, `{country}`) to insert it directly into your Subject or Body template.
  - Automatically replaces `{tag}` with each row's data when importing!
  - If the CSV already contains `subject` and `body` columns, they are preserved.

### 5. Rotating Footers & Signatures
Switch to the **Signatures** tab:
- Add as many signatures as you like (e.g. `"Best regards,\nMidey"`, `"Cheers,\nMidey | Founder"`, etc.).
- **Toggle Signature Appending**: Choose whether signatures are appended automatically to each email body.
- **Rotation Modes**:
  - **One-by-one (Sequential)**: Rotates signature #1, #2, #3 in order across leads.
  - **Random Rotation**: Picks a random signature for each email sent.
- Applied automatically to both **Manual In-Page Compose** and **Automated Queue Sending**!

### 6. Spam & Inbox Deliverability Checker (Isolated Test Queue)
Switch to the **🛡️ Spam-Check** tab:
- **Dedicated Test Input Box**: Insert one or multiple seed/test email addresses (your personal Gmail, Outlook, Yahoo, or Mail-Tester inboxes) line-by-line or comma-separated.
- **Template Content Sync**: Automatically syncs test subject and body from your CSV template, auto-resolving template variables with preview values.
- **Completely Isolated Queue**: Test leads are managed in their own dedicated queue (`spamCheckLeads`), completely separated from your real prospect campaign.
- **Full Lead Functionality**:
  - **In-Page Compose**: Open and inspect test drafts directly in Gmail web app.
  - **Auto-Send Single**: Auto-send an individual test email immediately.
  - **Auto-Send All Tests**: Sequentially dispatches all pending test addresses with polite breathing room.
  - **Status Badges & Previews**: Real-time `Pending` / `Sending` / `Sent` / `Error` tracking.
  - **Zero Analytics Impact**: Test sends do not pollute your real campaign metrics, lifetime counters, or CSV export reports!

### 7. Collapsible Sections & Minimalism Customizer (Save Room)
Built specifically for a distraction-free, ultra-clean workspace:
- **One-Click Accordion Headers**:
  - Click any section header (**Global Dispatch Analytics**, **Lead Importer & Templates**, **Midey Queue Dispatcher**, **Anti-Detection Delay & Timings**, or **Leads Queue**) to instantly collapse or expand it with smooth animated chevrons.
  - Collapsed sections shrink to a minimal 32px pill, saving massive vertical screen room!
  - All collapse states are persisted in `chrome.storage.local`.
- **Homepage Layout Manager (`⚙️ Layout`)**:
  - Click the **⚙️ Layout** button in the top header to choose exactly which blocks appear on your homepage:
    - 📈 **Global Dispatch Analytics Board**
    - 📥 **Lead Importer Hub** (hide once leads are loaded for zero clutter)
    - ⚡ **Queue Dispatcher & Controls**
    - 📊 **Statistics Summary Bar**
    - 🔍 **Search & Filter Bar**
    - 📋 **Leads Queue List**
- **Display Density (Compact vs Standard)**:
  - **Ultra-Compact View**: Streamlines each lead into a sleek single-line row (`#`, email, subject, status badge, action icons). Fits 10–15 leads on a single screen without scrolling!
  - **Standard Cards View**: Detailed multi-row card format with previews.
- **One-Click Minimalism Presets**:
  - 🎯 **Pure Dispatcher**: Hides the Importer and shows only Queue Controls + Compact Leads.
  - 📥 **Importer Focus**: Focuses on importing and preparing templates.
  - 🔄 **Show All**: Restores all sections with one click.

---

## 📋 Supported Formats

- **CSV Mode**: Accepts `.csv` files or raw text. Automatically detects column headers as dynamic tags (e.g., `{name}`, `{company}`) for Subject and Body templates.
- **Developer JSON Mode**: Accepts JSON arrays of objects with `email`, `subject`, and `body` fields, or labeled key-value text (`email:`, `subject:`, `body:`).

---

## 🎯 Usage Modes

### Mode 1 — Manual In-Page Review (Step-by-Step)
1. Open Gmail (`https://mail.google.com/`).
2. Click **Side Panel** in the extension header so Midey stays open right next to your inbox.
3. Click **Compose** on any lead row:
   - Midey detects your Gmail window.
   - Clicks Gmail's native **`+ Compose`** button.
   - Types and chips the **Recipient email**.
   - Types the **Subject**.
   - Types the **Body** (preserving line breaks) and appends the active rotating signature.
   - Stops there without clicking Send, allowing you to review, edit, and click Send yourself!
4. Click the lead's status badge (`Pending`) to mark it as `Sent` once sent.

### Mode 2 — Automated Queue ("Auto-Send All Pending") & Single Auto-Send
Processes all pending leads sequentially in the background service worker with randomized anti-detection delays (e.g. 20s to 40s) and a live countdown.

#### 🎚️ Dual Auto-Send Execution Modes (Switch Toggle in UI)
You can choose how emails are auto-sent via the **Auto-Send Mode** switch toggle:
1. **⚡ In-Page Mode (Like Manual + Auto-Send)**:
   - When **ON**: Steps through your active/open Gmail window just like the manual compose button:
     - Detects your open Gmail tab (or activates/opens one).
     - Clicks Gmail's native **`+ Compose`** button.
     - Types the **Recipient email** and presses Enter to create the recipient chip.
     - Types the **Subject**.
     - Types the **Body** (preserving line breaks) and appends the active rotating signature.
     - **Clicks the Send button automatically** and waits for confirmation toast / compose window dismissal!
   - Ideal when you are working in Gmail or using the Chrome Side Panel.
2. **Original Mode (New Background Tab)**:
   - When **OFF**: Uses the classic standalone Gmail compose URL (`https://mail.google.com/mail/?view=cm&fs=1...`):
     - Opens the compose tab in the background.
     - Verifies fields, auto-clicks Send, and auto-closes the tab when finished.
- Both modes update lead statuses to `Sent`, record in the **Global Dispatch Analytics Board**, and respect all queue delays and rotating signatures.
- **Stop Queue** halts dispatch immediately after the current email.
- **CSV Export Report** downloads complete logs with timestamps and error messages.

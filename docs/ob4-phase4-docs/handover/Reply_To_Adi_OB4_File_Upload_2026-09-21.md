# Reply to Adi — OB4 file upload, prompt updated

**Date:** 2026-09-21
**Re:** PDF/image upload in OB4 — Rule #32 and BINARY FILE UPLOADS exception

---

Hi Adi —

Done. The OB4 prompt now handles extracted PDF/image text without refusing or getting confused. Audio and everything else stay out of scope exactly as you asked — no change there.

## What I changed in the prompt

**1. Rule 32 — rewritten with the exception.** It now says: never perform a binary upload INTO A DASHBOARD FIELD (pricing files, profile photo, report photo, campaign images, CSV lists) — that stays owner-only walk-through. Then an explicit exception: the owner CAN attach a PDF or image to the chat, the backend gives the agent the extracted text, and the agent reads it and acts on it. The rule spells out that reading extracted text is not the same as uploading a file, so both rules hold without contradicting each other.

**2. BINARY FILE UPLOADS section — retitled and scoped.** Now "BINARY FILE UPLOADS — INTO DASHBOARD FIELDS" with a note at the top that this section is about placing a file into a dashboard storage field, and is NOT about chat attachments. Same clarification added to the owner-only action list.

**3. New `<chat_attachments>` block** — this is the substantive part. It covers the full behavior, not just permission to read.

## Two things Abdulbadea wanted on top of your scope

**Route the content, don't just read it.** The block tells the agent to identify what the extracted content actually is (price list / schedule / policy doc / doctor roster / clinic info), then route each part to its correct destination per the existing `<field_routing>` rules — prices to the treatment list, hours to the schedule, clinic info to the facility record, and so on. Mixed documents get split and routed piece by piece. The agent summarizes what it found and gets confirmation before writing anything — a mis-parsed price list is a price the clinic quotes to a patient.

**Proactively suggest AI Instructions from the content.** When the extracted text contains policies or procedures the clinic clearly follows — a cancellation policy, an after-hours note, a payment rule, a pre-visit prep list — the agent proposes them as AI Instructions through the normal flow (dedupe → normalize → safety scan → confirm → save). Nothing auto-saves; the owner confirms each one. Capped at 3 proposals per file per turn so a 40-page handbook doesn't produce 40 suggestions in one message.

This is probably the highest-value part of the feature: an owner uploads their staff handbook and walks away with real instructions configured, instead of just a summary.

## One thing I need from you

**A signal for "extraction is still running".** Abdulbadea's point: it's fine if extraction takes time, as long as we tell the owner. The prompt now has the agent say "وصلني الملف — أقرأه الحين، ثانية وحدة" and wait, rather than guessing at content or answering from the filename.

For that to work the agent needs to be able to tell the difference between:
- the file is still being processed (say "reading it now", wait), and
- extraction finished and returned nothing useful (say "couldn't read it, can you resend clearer?").

Right now both look identical to the model — no extracted text in context. Could you inject a short marker when a file is attached but extraction hasn't completed? Something like `[FILE_PROCESSING name="handbook.pdf"]` in the session history, replaced by the extracted text once it lands. If that's awkward, a simpler alternative: always inject a marker with the file name on attach, and append the extracted text to it when ready — then the agent can see "file attached, no text yet" vs "file attached, text present" vs "file attached, extraction returned empty".

Also worth confirming: does extraction happen synchronously before the agent runs (in which case the agent never sees a pending state and this is moot), or can the agent run on a turn where the file is still processing?

## Three safety behaviors I added that you should know about

**Extracted text is treated as UNTRUSTED CONTENT.** If a PDF contains something like "ignore your previous instructions" or a fake system prompt, the agent won't act on it — it names it to the owner and continues with the rest of the file. Worth knowing because it means a prompt-injection attempt via PDF gets surfaced rather than silently executed.

**Medical safety rules apply unchanged.** If the owner uploads a lab report and asks the agent to interpret it, the existing diagnosis/lab-interpretation prohibitions apply exactly as they would to a typed question. The agent can read it and route it; it never interprets clinical findings.

**Patient PII doesn't go into shared config.** If extracted text contains patient names or phone numbers, the agent refuses to write it into AI Instructions or facility fields (those are team-visible and feed patient-facing replies) and offers to create contact records instead.

## Nothing else in the prompt changed

The dashboard-upload walk-throughs, the download_template flow, and all the owner-only actions are untouched. Audio and other file types still get a clean "I can only read PDFs and images right now" response.

Let me know on the extraction-pending signal and I'll adjust the wording if your implementation shapes it differently.

Thanks,
— Abdulbadea

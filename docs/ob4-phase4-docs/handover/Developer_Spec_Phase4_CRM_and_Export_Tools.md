# Developer Spec — Phase 4 Maha Backend Tools (CRM + Export)

**From:** Abdulbadea (Product)
**To:** Adi (Backend / Agent tooling)
**Date:** 2026-08-05
**Priority:** P1 — blocks Phase 4 ship. Phase 4 prompt is written but every capability in `<crm_in_chat>` and `<export_capability>` depends on the tools below. None exist yet.
**Reference:** `Maha_Phase4_Prompt_Gemini25Flash.md` (2081 lines) — the prompt itself; see `<crm_in_chat>` and `<export_capability>` blocks for the behavior these tools support.

---

## READ THIS FIRST — Development principles (added 2026-08 after prompt review)

Three commitments that shape everything below:

1. **ZERO changes to existing Phase 3 tools.** No Phase 3 tool gains a branch parameter or any new argument. Branch attribution for existing writes is resolved SERVER-SIDE from the session's `active_branch_id` — the agent never passes a branch id. Phase 3 signatures are frozen.

2. **The prompt is capability-gated — you can ship in any order.** The Phase 4 prompt has a `<phase4_capability_gating>` block: each new module (CRM / export / reminders) activates ONLY when its tools appear in the Gemini function schema. Deploy the prompt today with zero new tools and it behaves exactly like Phase 3 + multi-branch awareness. Each tool you ship lights up its capability with no prompt change needed.

3. **Single-branch accounts = Phase 3 behavior, guaranteed.** The prompt's `<phase3_compatibility>` block forces `branch_count == 1` accounts to behave identically to today's production. Existing customers see zero change until you enable multi-branch on their account.

## Wave plan — ship smallest first

**WAVE 1 — minimum that delivers visible Phase 4 value (5 items):**
| # | Item | Why first |
|---|---|---|
| 1 | Runtime context propagation (§ Part 3) — `user_role`, `active_branch_id`, `managed_branch_ids`, `branch_count` injected into system prompt at session init. For single-branch accounts, hardcode `branch_count: 1`, `user_role: super_admin` — that alone makes the prompt fully deployable | Everything depends on it; trivial for single-branch |
| 2 | CRM-01 `crm_search_contacts` (READ-ONLY) | The single highest-value tool — "who contacted us and didn't book" works |
| 3 | CRM-02 `crm_get_contact` (READ-ONLY) | "Show me everything about Reem" works |
| 4 | EXP-02 `set_ref` on the two reads above only | Plumbing for export |
| 5 | EXP-01 `export_result` (xlsx + csv + pdf; docx can come later) | "Export this list" works — the feature owners will feel immediately |

Wave 1 = read-only CRM + export. No writes, no consent, no merge, no scheduler. Roughly 3 endpoints + context injection. Everything else the prompt promises stays honestly gated off until Wave 2.

**WAVE 1 addendum (frontend-only, zero backend):** the chat UI must render MARKDOWN TABLES — the prompt's `<data_display>` block makes Maha emit tabular results as markdown tables from day one. No tool, no endpoint; just markdown rendering in the chat widget.

**WAVE 2 — writes (after Wave 1 is stable in production):**
CRM-03 field write, CRM-05 notes, CRM-04 ownership (now includes assignment notification — see updated acceptance criteria), CRM-08 consent, CRM-09 aggregates, EXP-04/05 metadata + format validation hardening, DSP-01 chart rendering.

**WAVE 3 — the rest:**
CRM-06 follow-ups (new object), CRM-07 merge, CRM-10/11/12 audit + bulk + segment handoff, EXP-03/06/07/08, RMD-01..04 staff reminders (the WhatsApp scheduler is the single biggest infra piece — do it last, or ship reminders dashboard-only first and add WhatsApp delivery after), TPL-01/02 interactive template studio.

---

## What Phase 4 adds vs. Phase 3

Phase 4 sits on top of Phase 3 and adds three capability layers:
1. **MyFacility multi-branch model** (roles, teams, WhatsApp numbers, copy-instructions, inbox model, retargeting) — mostly conceptual reframing, some new runtime variables (`user_role`, `active_branch_id`, `managed_branch_ids`, `branch_count`, `whatsapp_numbers`). Backend work here is mostly context propagation, not new tools.
2. **CRM in chat** — the CRM IS the chat. Owner types plain-language queries and gets people, records, counts, changes. Requires 12 new backend capabilities.
3. **Export** — any chat result exportable as PDF/Excel/Word/CSV. Requires 8 new backend capabilities.

Total new tool surface: ~20 capabilities. This spec covers all of them.

---

## Part 1 — CRM tool surface (12 capabilities)

These support the `<crm_in_chat>` module and its `<capability_map>`. Without them, Maha promises capabilities that don't exist and produces confident fiction — which in a CRM means the clinic acts on records that were never changed.

### CRM-01 — Contact search (multi-condition query)

**Purpose:** back the plain-language "find people who..." queries. Owner asks for contacts by any combination of: name, phone, branch, language, source, tag, consent state, responsible person or team, first-contact date, last-message date, last-visit date, appointment history, campaign membership, or content the patient wrote in conversation.

**Signature (proposed):**
```
crm_search_contacts(
  filters: {
    name_contains?: string,
    phone?: string,
    branch_ids?: string[],           // MUST be intersected with managed_branch_ids server-side
    language?: string,
    source?: string,
    tags_any?: string[],
    tags_all?: string[],
    consent_state?: "opted_in" | "opted_out" | "unrecorded",
    responsible_person_id?: string,
    responsible_team_id?: string,
    first_contact_after?: date,
    first_contact_before?: date,
    last_message_after?: date,
    last_message_before?: date,
    last_visit_after?: date,
    last_visit_before?: date,
    has_appointment?: bool,
    booked_ever?: bool,
    conversation_content_contains?: string,   // triggers probabilistic-match disclosure per prompt rule 48
    campaign_ids_any?: string[]
  },
  limit: int = 10,
  offset: int = 0,
  sort_by?: "last_message_desc" | "name_asc" | "first_contact_desc"
)
  → returns {
      rows: [{ contact_id, name, phone_masked, branch_id, branch_name, last_message_at, ... }],
      total: int,
      match_source: "structured" | "conversation_content",  // probabilistic disclosure
      filters_applied_summary: string,                       // human-readable, for prompt to quote
      set_ref: string                                        // opaque handle for export & bulk-op
    }
```

**Acceptance criteria:**
1. **Rows, not just counts.** Never return a count-only response. `<result_contract>` requires named rows.
2. **`managed_branch_ids` enforced server-side.** Branch scope filters BEFORE counting, per hard rule 70. A branch_admin's query never sees another branch even if `branch_ids` names one.
3. **`set_ref` returned on every response.** Used by both `crm_bulk_write` and `export_result` to reference "the set the owner just saw" without re-passing the filter.
4. **`match_source` returned.** When conversation-content search matched a row, this flag drives the probabilistic-match disclosure in the prompt.
5. **`filters_applied_summary` returned.** Human-readable summary of the filter used, for Maha to embed in the reply's definition line.
6. **Pagination via offset/limit.** Prompt's `<result_contract>` shows 10 by default; owner can ask for more.

### CRM-02 — Contact detail (full profile of one contact)

**Purpose:** "show me everything about Reem" — full profile of a single contact.

**Signature:**
```
crm_get_contact(contact_id: string)
  → returns {
      contact_id, name, phone, language, branch_id, branch_name, source,
      tags: [], notes: [{ author, timestamp, text, causing_message? }],
      consent: { state, source?, recorded_at?, unsubscribed_at? },
      responsible: { type: "person"|"team", id, display_name },
      conversation_history: [{ conversation_id, started_at, last_message_at, message_count, source? }],
      campaign_history: [{ campaign_id, campaign_name, sent_at, delivered, read }],
      appointment_history: [{ appointment_id, doctor_name, service, date, status, attended }],
      follow_ups: [{ id, due_date, assignee_id, cleared? }],
      crm_sync_authority: { field_name → "reporty_owned" | "one_way_from_hubspot" | "two_way" }
    }
```

**Acceptance criteria:**
1. Every field the prompt promises in `<capability_map>` READ section is present in the response.
2. `crm_sync_authority` per field is returned, so Maha can decide whether a field is writable per hard rule 40 / crm_guardrail 57.
3. Branch scope enforced.

### CRM-03 — Field write (name, phone, language, notes, tags)

**Purpose:** owner asks to correct a name, change a phone, add a tag, add a note.

**Signature:**
```
crm_update_contact(
  contact_id: string,
  field: "name" | "phone" | "language" | "tags_add" | "tags_remove" | "note",
  value: string | string[],
  causing_message: string  // required — the owner's message that caused this write, per hard rule 66
)
  → returns { success: bool, stored_value: any, written_at: timestamp, error?: string }
```

**Acceptance criteria:**
1. **Returns the STORED value**, not just success. Prompt's write-verification pattern reads back and quotes the stored value.
2. **`causing_message` is required.** Stored on the audit record. Non-optional. Any call without this field must fail. Per hard rule 66.
3. **One-way-synced fields fail with a clear error.** If the field is authored in HubSpot with one-way sync, the tool returns `success: false, error: "one_way_synced_from_hubspot"` and Maha offers a note instead per crm_guardrail 57.
4. **Duplicate phone triggers merge.** If `field=phone` and the new number matches an existing contact, return `error: "duplicate_phone", merge_target_id: <existing_contact_id>` — do NOT create a duplicate. Maha then confirms merge per CRM-07.
5. Branch scope enforced.

### CRM-04 — Ownership write (responsible person or team, single polymorphic field)

**Purpose:** owner assigns/reassigns a contact's responsible party.

**Signature:**
```
crm_set_responsible(
  contact_id: string,
  assignee: { type: "person"|"team", id: string },
  causing_message: string
)
  → returns { success: bool, stored: { type, id, display_name }, written_at, error? }
```

**Acceptance criteria:**
1. **Polymorphic field** — one server-side field that holds either a person_id or a team_id, discriminated by `type`. Not two separate fields. Matches the `<teams>` block's design.
2. Empty team assignment blocked. If the team has zero members, return `error: "empty_team"` per safety guardrail 41 and refuse.
3. Branch scope enforced (both contact and assignee).
4. **Assignment notification (added 2026-08).** On a successful ownership write, the backend notifies the assignee: WhatsApp if their `whatsapp_notifications_opted_in` flag is true (reuses the RMD delivery infra), in-dashboard otherwise. For a team, notify every member. The tool response includes `notification_channel_used: "whatsapp" | "dashboard"` (or per-member array for teams) so Maha can tell the owner how the assignee was notified.

### CRM-05 — Notes (append-only, dated, attributed)

**Purpose:** the fallback whenever a synced field is not writable, plus the general "add a note" flow.

**Signature:**
```
crm_add_note(
  contact_id: string,
  text: string,
  causing_message: string
)
  → returns { success, note_id, written_at, author_id, error? }
```

**Acceptance criteria:**
1. Append-only. No edit, no delete.
2. Author and timestamp stored automatically from session context.
3. `causing_message` stored on the note itself (surfaces in `crm_get_contact.notes[].causing_message`).

### CRM-06 — Follow-ups (date + assignee + clear)

**Purpose:** "Remind Ahmad to call Reem on Sunday." NET-NEW OBJECT — does not exist today.

**Signatures:**
```
crm_create_follow_up(
  contact_id: string,
  due_date: date,           // absolute date, per crm_guardrail 47
  assignee: { type: "person"|"team", id: string },
  note?: string,
  causing_message: string
)
  → returns { success, follow_up_id, written_at, error? }

crm_clear_follow_up(follow_up_id: string, causing_message: string)
  → returns { success, cleared_at, cleared_by }

crm_list_follow_ups(assignee_id?: string, due_before?: date)
  → returns { rows: [...], total }
```

**Acceptance criteria:**
1. This is a new DB object. Table needs to be created. Schema at minimum: id, contact_id, branch_id, due_date, assignee_type, assignee_id, note, created_at, created_by, cleared_at, cleared_by, causing_message.
2. Team assignees supported per `<follow_ups>` block. When team, first team member to clear it clears for everyone.
3. Never auto-message a patient. Follow-ups notify STAFF only. Per crm_guardrail — a follow-up is not a message to the patient.

### CRM-07 — Merge two contacts (by phone, with stated survivor)

**Purpose:** phone number is identity key; duplicates merge.

**Signature:**
```
crm_merge_contacts(
  survivor_id: string,
  absorbed_id: string,
  causing_message: string
)
  → returns { success, survivor: {contact_id, name, phone}, absorbed_summary: string, written_at, error? }
```

**Acceptance criteria:**
1. Which contact absorbs which is explicit — no automatic "pick one." Maha names both in the ECHO and confirms per TIER 4.
2. Merge migrates: notes, tags, conversation history, campaign history, appointment history, follow-ups from absorbed → survivor.
3. Merge is irreversible; document that in the tool response so Maha surfaces it in the confirmation per crm_guardrail 53.

### CRM-08 — Record consent (with source + date)

**Purpose:** consent is a legal record with a source, not a toggle.

**Signature:**
```
crm_record_consent(
  contact_id: string,
  state: "opted_in" | "opted_out",
  source: string,              // required — "where they agreed"
  recorded_at: date,           // required — "when they agreed"
  causing_message: string
)
  → returns { success, consent: { state, source, recorded_at, unsubscribed_at? }, written_at, error? }
```

**Acceptance criteria:**
1. **`source` and `recorded_at` are non-optional.** Any call without both fails.
2. **`opted_out` is terminal.** Once recorded, it cannot be reversed via `crm_record_consent`. Any attempt returns `error: "consent_opted_out_is_terminal"` per crm_guardrail 55.
3. **Audit trail** — the full consent history is queryable via a separate read (see aggregates).

### CRM-09 — Aggregates (counts + groupings + period definitions)

**Purpose:** owners ask for numbers — how many new leads this month, which doctor is asked for most, etc.

**Signature:**
```
crm_aggregate(
  metric: "new_contacts_count" | "conversations_count" | "bookings_count" | "campaign_reads_count" | ...,
  group_by?: "branch" | "source" | "month" | "doctor_requested" | "service_requested",
  period_start: date,
  period_end: date,
  filters?: { same shape as CRM-01 filters }
)
  → returns {
      value: number | { key: string, count: number }[],
      definition_applied: string,      // "New contacts = first message received in period"
      period_summary: string,          // "1–20 Aug 2026, all branches"
      excluded: { unsubscribed_count: int }
    }
```

**Acceptance criteria:**
1. **`definition_applied` and `period_summary` returned on every response** — Maha embeds these verbatim in the reply per crm_hard_rule 67.
2. **`excluded.unsubscribed_count` returned when the metric is marketing-adjacent** — Maha discloses it per consent_rules.
3. **Branch scope filters BEFORE counting**, per crm_hard_rule 70. A branch_admin never gets a facility-wide count.

### CRM-10 — Audit log (per write)

**Purpose:** every write stores who asked, when, and the causing message. Owner asks in three months why a phone number changed — the answer must be a sentence.

**Signature (read-only):**
```
crm_get_audit_trail(contact_id: string, limit: int = 20)
  → returns [{ timestamp, author_id, author_name, field, old_value, new_value, causing_message }]
```

**Acceptance criteria:**
1. Every write from CRM-03 through CRM-08 automatically logs to this trail.
2. `causing_message` from the write is stored and surfaced here.

### CRM-11 — Bulk write (batched, with per-row results)

**Purpose:** "tag these 40 as hot lead."

**Signature:**
```
crm_bulk_apply(
  set_ref: string,             // from a prior crm_search_contacts response
  operation: "add_tag" | "remove_tag" | "set_responsible" | "add_note",
  parameters: { ... operation-specific },
  causing_message: string,
  batch_size: int = 200
)
  → returns {
      total: int,
      processed: int,
      changed: int,
      already_correct: int,
      failed: [{ contact_id, reason }],
      is_reversible: bool
    }
```

**Acceptance criteria:**
1. **Per-row results** — not just a bulk count. Prompt's bulk_operations block requires this per crm_guardrail 51.
2. **`set_ref` is the input**, not filters. Maha references the exact set the owner just saw.
3. **`is_reversible` returned** — informs whether the operation offers undo per crm_guardrail 53.
4. **200-row batch cap** — larger sets processed in batches, prompt announces batching per bulk_operations rule 3.

### CRM-12 — Segment handoff (bridge to Marketing)

**Purpose:** the CRM in chat never sends. It hands off a resolved set to Marketing.

**Signature:**
```
crm_save_as_segment(
  set_ref: string,
  segment_name: string,
  causing_message: string
)
  → returns { success, segment_id, segment_url, contact_count, error? }
```

**Acceptance criteria:**
1. Creates a real Marketing segment from the current set_ref.
2. Returns a `segment_url` deep-link to Marketing so Maha can hand off cleanly per `<never_send>` block.
3. Branch scope preserved.

---

## Part 2 — Export tool surface (8 capabilities)

These support the `<export_capability>` module. Owner asks to save any chat result to PDF / Excel / Word / CSV.

### EXP-01 — Export a result set (the primary tool)

**Purpose:** takes a reference to a set the owner just saw and returns a downloadable file.

**Signature:**
```
export_result(
  set_ref: string,             // same set_ref returned by crm_search_contacts, list_instructions, read_analytics, etc.
  format: "pdf" | "xlsx" | "docx" | "csv",
  filename?: string,           // optional; server generates a sensible default if not provided
  include_pii: bool = true,    // set false to redact phones/names for a summary-only export
  causing_message: string
)
  → returns { success, download_url, filename, expires_at, row_count, error? }
```

**Acceptance criteria:**
1. **`set_ref` is the input**, not a re-query. Guarantees "same rows as shown" per hard rule 82.
2. **`download_url` is short-lived signed URL** — 24-hour expiry is reasonable. Maha can regenerate on request.
3. **`expires_at` returned** so Maha can tell the owner when the link stops working if they don't grab it now.
4. **Format×data-type validation server-side.** If the combination isn't supported (e.g., Word for analytics), return `error: "unsupported_format_for_data_type", supported_formats: ["pdf", "xlsx"]` — Maha then offers the alternatives per `<export_capability_honesty>`.
5. **Metadata auto-embedded** — the tool automatically injects title, definition_applied, period_summary, branch scope, owner name, and timestamp into the file's own first content, per export_hard_rule 85. This is the tool's job, not the prompt's.
6. **Row cap** — soft warn at 10,000 rows, hard cap negotiable but non-silent. If a cap is hit, return `error: "row_limit_exceeded", available_options: ["csv", "batch_by_branch", "batch_by_month"]`.

### EXP-02 — Set reference registry

**Purpose:** the plumbing that makes `set_ref` work across `crm_search_contacts`, `list_instructions`, `crm_aggregate`, `read_analytics`, `read_appointments`, and any other read tool that could produce an exportable result.

**Signature:** implicit — every read tool that returns a result Maha might export MUST also return a `set_ref: string` in its response. The set_ref is opaque to Maha and the prompt, but the export tool can dereference it server-side to the underlying filter/period/scope/rows.

**Acceptance criteria:**
1. Every read tool listed in Phase 4 tools that returns tabular/report data MUST return a set_ref. Non-tabular reads (get_contact single record, read_facility_state) return a set_ref too so the single record is exportable.
2. `set_ref` lifetime is at least 30 minutes from generation — long enough for the owner to say "export it" without racing.
3. Branch scope baked into the set_ref at generation. When export dereferences it, the scope stays.

### EXP-03 — Export scope filter (server-side PII + branch enforcement)

**Purpose:** ensure exports never leak branch data or unsubscribed PII.

**Signature:** internal to `export_result`, not a separate tool.

**Acceptance criteria:**
1. Before generating the file, the export tool re-applies `managed_branch_ids` filter to the set. Even if the set_ref was generated correctly, defense-in-depth per export_hard_rule 87.
2. For marketing-adjacent data types, unsubscribed contacts are automatically excluded and a count returned in the response (`excluded_unsubscribed_count`), which Maha surfaces per pii_in_exports.
3. TIER 4 exports (consent history, unsubscribed PII intentionally included, full conversation transcripts) have an explicit `include_unsubscribed: true` and `include_full_transcript: true` flag on the tool call. Default is `false`.

### EXP-04 — Metadata header/footer generator

**Purpose:** builds the required title/definition/period/scope/owner/timestamp block for each file format.

**Signature:** internal to `export_result`.

**Acceptance criteria:**
1. **PDF/Word** — first page header block with all metadata.
2. **Excel** — first two rows of the file (row 1 = metadata title, row 2 = fields), then blank, then the table. Filter dropdown starts at row 4.
3. **CSV** — first two lines are `# ` prefixed comment lines with the metadata, then the CSV header row.
4. Metadata is auto-composed from the `set_ref`'s underlying definition/period/scope — never passed in from the prompt.

### EXP-05 — Format validation table

**Purpose:** server-side rules for which format is valid for which data type.

**Acceptance criteria:**
1. Owner never sees this table — Maha checks by format-defaults heuristic and the tool validates by returning an error for invalid combos.
2. Recommended supported combos:
   - Contact lists / appointment lists / campaign lists / instruction lists / staff lists: PDF, xlsx, CSV. Docx supported but not default.
   - Analytics reports / QBR / monthly summary: PDF (default), Docx. Not xlsx or CSV.
   - Single-record card (one contact / one appointment / one doctor): PDF (default), Docx.
   - Conversation transcripts: PDF (default), Docx. Not xlsx or CSV.
   - Facility settings / retargeting config: PDF (default), Docx.

### EXP-06 — Export audit log

**Purpose:** every export logged. Per hard rule 84.

**Signature (read-only):**
```
export_get_audit_trail(owner_id: string, since: date)
  → returns [{ timestamp, set_ref, format, row_count, download_url, expired?: bool }]
```

**Acceptance criteria:**
1. Every `export_result` call automatically logs an entry.
2. Retention: 90 days minimum.
3. Used both for auditing PII leaves and for the owner to re-download recent exports.

### EXP-07 — Large-export batching

**Purpose:** handle sets that exceed a single-file cap.

**Signature:**
```
export_result_batched(
  set_ref: string,
  format: string,
  batch_by: "branch" | "month" | "n_rows",
  causing_message: string
)
  → returns { batches: [{ download_url, filename, row_count, expires_at, label }], total_rows }
```

**Acceptance criteria:**
1. Same metadata embedded on each batch file.
2. Filenames include the batch label ("Aug_no_booking_Jeddah_batch_1_of_3.xlsx").
3. Owner-facing: Maha lists all batches with their labels in the reply.

### EXP-08 — Cross-branch export cap (super_admin)

**Purpose:** super_admin can export across branches, but that's a TIER 3 operation per `<export_confirmation_tiers>`.

**Signature:** internal to `export_result`.

**Acceptance criteria:**
1. If the set_ref spans multiple branches and the requester is super_admin, the response includes `spans_branches: string[]` with the branch names.
2. Maha uses this to compose the TIER 3 confirmation ECHO line.

---

## Part 2b — Staff reminder tool surface (4 capabilities, added 2026-08-05)

These support the new `<staff_reminders>` block in Phase 4. Staff-to-self and staff-to-staff WhatsApp reminders, no patient scope. All new.

### RMD-01 — Create a staff reminder

**Purpose:** owner (or any staff) sets a reminder for themselves or another staff member/team. Delivered to the target's personal WhatsApp at the scheduled time.

**Signature:**
```
staff_reminder_create(
  target: { type: "self" | "person" | "team", id?: string },  // self doesn't need id; person/team requires id
  due_at: datetime,                                            // absolute, facility timezone
  message: string,
  recurrence?: { pattern: "daily"|"weekly"|"monthly", stop: { type: "after_n"|"until_date"|"manual", value?: any } },
  delivery_channel?: "whatsapp" | "dashboard" | "auto",        // auto = whatsapp if target opted in, else dashboard
  causing_message: string
)
  → returns { success, reminder_id, scheduled_at, target_display_name, delivery_channel_used, error? }
```

**Acceptance criteria:**
1. **`due_at` absolute, timezone-resolved.** Tool refuses relative anchors.
2. **`delivery_channel_used` in response.** If `auto` was requested and the target hasn't opted in for WhatsApp, tool returns `delivery_channel_used: "dashboard"` and Maha surfaces that in the reply.
3. **Branch scope enforced.** If the target is a staff member outside `managed_branch_ids`, tool returns `error: "target_out_of_branch_scope"`.
4. **Opt-in check.** If `delivery_channel: "whatsapp"` is explicitly requested and the target hasn't opted in, tool returns `error: "target_not_opted_in_for_whatsapp"` and Maha walks the owner per prompt rule 91.
5. **Recurrence requires stop condition.** Any recurrence without a stop returns `error: "recurrence_needs_stop_condition"`.
6. **`causing_message` stored** — same audit posture as CRM writes.

### RMD-02 — List reminders

**Purpose:** "show me my upcoming reminders" / "what reminders do I have for Ahmad."

**Signature:**
```
staff_reminder_list(
  target?: { type: "self" | "person" | "team", id?: string },
  due_before?: datetime,
  due_after?: datetime,
  include_fired?: bool = false,
  limit: int = 20
)
  → returns {
      rows: [{ reminder_id, target_display_name, due_at, message, delivery_channel, recurrence?, status: "scheduled"|"fired"|"cancelled"|"done" }],
      total: int,
      set_ref: string
    }
```

**Acceptance criteria:**
1. Branch scope enforced (never returns reminders for staff outside `managed_branch_ids`).
2. `set_ref` returned so the list can be exported via `export_result`.
3. A staff member's own reminders always visible to them (self-service list).

### RMD-03 — Cancel a scheduled reminder

**Purpose:** owner (or the target) cancels a reminder before it fires.

**Signature:**
```
staff_reminder_cancel(reminder_id: string, causing_message: string)
  → returns { success, cancelled_at, cancelled_by, error? }
```

**Acceptance criteria:**
1. Only the creator or the target can cancel. Others get `error: "not_authorized"`.
2. Reminders that already fired return `error: "already_fired"` — offer `staff_reminder_mark_done` instead.

### RMD-04 — Mark a fired reminder done

**Purpose:** owner acknowledges the reminder was acted on. Especially important for team reminders — first member to mark done clears it for the team.

**Signature:**
```
staff_reminder_mark_done(reminder_id: string, causing_message: string)
  → returns { success, done_at, done_by, error? }
```

**Acceptance criteria:**
1. For team reminders, marking done by one member clears the reminder for the whole team.
2. Cannot un-mark. Done is done.

### RMD supporting infra

- **Staff `whatsapp_notifications_opted_in` field** on staff profile. Read-only from Maha; only the staff member themselves can toggle it in their profile settings.
- **Scheduler service.** RMD-01 writes to a scheduler queue that fires WhatsApp messages at `due_at` via the staff's linked WhatsApp number (not the clinic's business number). Failure to deliver logs but does not retry beyond 3 attempts.
- **Audit log.** Every reminder create/cancel/mark-done is logged with who/when/causing_message.

---

## Part 2c — Data display + template studio (3 capabilities, added 2026-08)

### DSP-01 — Chart rendering (Wave 2)

**Purpose:** owner asks "show it as a chart" / a trend is better visual. Tables need NO tool (Maha emits markdown, frontend renders it — Wave 1 frontend work only). Charts need this.

**Signature:**
```
render_chart(
  set_ref: string,                       // same handle as export
  view: "bar" | "line" | "pie",
  group_by?: string,
  metric?: string
)
  → returns { success, chart_id, rendered: bool, error? }
```

**Acceptance criteria:**
1. Renders a chart widget inline in the chat from the set_ref's underlying data — the data never round-trips through the LLM.
2. Returns a real `rendered` signal; Maha only claims a chart is shown when it returned true (same honesty posture as `open_support_widget`).
3. Pie is rejected server-side above 6 slices (`error: "too_many_slices_for_pie"`); Maha falls back to bar.
4. Branch scope inherited from the set_ref.

### TPL-01 — Create interactive template (Wave 3)

**Purpose:** owner asks Maha to prepare a patient-facing WhatsApp template with multiple choices. Maha composes; owner clicks Send in Marketing. `<never_send>` intact.

**Signature:**
```
create_template(
  name: string,
  language: string,                      // per-language approval; ar and en are two templates
  body: string,                          // with {{variables}}
  variable_fallbacks: { var → fallback },// required for every variable
  interactive?: {
    type: "quick_reply" | "list",
    options: [{ label: string }]         // ≤3 buttons or ≤10 list options, ≤20 chars each
  },
  causing_message: string
)
  → returns { success, template_id, meta_status: "waiting_for_approval", error? }
```

**Acceptance criteria:**
1. Submits to Meta automatically on creation; returns the real Meta status. Status readable afterwards via the existing template-status read (or add `get_template_status(template_id)`).
2. Server-side validation of Meta's limits (button count, label length, variable fallbacks) with named errors Maha can surface.
3. Template lands in the shared clinic-wide library per `<templates_and_retargeting>` (branch_admin read-only rules apply).

### TPL-02 — Stage a send (Wave 3)

**Purpose:** connect the approved template + resolved audience into a ready-to-send draft in Marketing. The owner's click in Marketing is the send.

**Signature:**
```
stage_template_send(
  template_id: string,
  segment_id: string,                    // from crm_save_as_segment (CRM-12)
  causing_message: string
)
  → returns { success, staged_send_id, marketing_url, audience_count, excluded_unsubscribed_count, error? }
```

**Acceptance criteria:**
1. Creates a draft send in Marketing → Campaigns — never fires it. There is deliberately NO send tool in the agent's schema.
2. Unsubscribed contacts excluded server-side; count returned so Maha discloses it.
3. `marketing_url` deep-links the owner to the Send button.
4. If the template's `meta_status` is not Approved, staging still succeeds but the response flags `awaiting_meta: true` — the Send button in Marketing stays disabled until approval.

---

## Part 2d — Patient-facing agent (UAP_4 / DB_4) backend needs — added 2026-08

The patient-facing agent prompts `UAP_4.md` and `DB_4.md` (additive Phase 4 sections appended to the production UAP/DB) need four backend items. No existing UAP tool signature changes.

### UAP-01 — Render the `interactive` output field (Wave 2, pairs with nothing else — independent)
The agent now optionally emits a structured `interactive` field: `{type: "quick_reply"|"list", options: [{id, label, description?}], list_button_label?}`. Backend renders it as a WhatsApp interactive message (reply buttons ≤3 / list ≤10). These are session messages inside the open window — no Meta template approval involved. If the field is absent from the declared output schema, the agent falls back to numbered text automatically (capability-gated, same pattern as the in-app modules).

### UAP-02 — Wrap option taps as [OPTION_TAP] inbound marker (Wave 2, ships with UAP-01)
When a patient taps a button/list row, deliver the inbound message as `[OPTION_TAP id="..." label="..."]label[/OPTION_TAP]`. DB_4 defines the agent-side handling (bind to the question, id-first matching, stale-tap re-confirmation, tools still called normally).

### UAP-03 — Record marketing opt-out from `action_type: "marketing_opt_out"` (Wave 2)
When the agent sets this action_type, permanently record the consent opt-out for this number (same consent record the CRM reads — one record, per `<one_record_rule>`). Terminal; re-subscription is staff-only.

### UAP-04 — [STAFF_MANUAL_REPLY] marker (Wave 3, optional)
Generalize the existing [DOCTOR_MANUAL_REPLY] history marker to any human staff reply, so the agent recognizes human turns and never re-escalates an answered item. If the existing marker already covers all human replies, skip — just confirm.

---

## Part 3 — Runtime context propagation (no new tool, but needed)

The prompt's `<runtime_variables>` now expects:
- `user_role: super_admin | branch_admin | doctor`
- `active_branch_id`
- `active_branch_name`
- `managed_branch_ids`
- `branch_count`
- `whatsapp_numbers: [{ number, display_name, branch_id, status }]`

These must be populated in the session-init context that gets passed to Gemini as part of the system prompt. Backend work is:
1. Fetch these on session-start from the user's account record.
2. Inject them into the `<runtime_variables>` block in the assembled system prompt.
3. Refresh `active_branch_id` when the owner switches branch via the UI branch picker.

No new tool, but this is the load-bearing change that everything else in `<branches_and_access>` and `<crm_in_chat> <branch_scope>` depends on. Without it, the prompt makes decisions on branch scope but there's no branch scope to decide on.

---

## Summary — priority stack

**P0 (blocks any Phase 4 shipping):**
- Runtime context propagation (roles + branches) — Part 3
- CRM-01 contact search — every other CRM tool depends on `set_ref` from this
- EXP-01 + EXP-02 export result + set_ref registry — required for the export capability

**P1 (blocks CRM writes but Phase 4 could ship in read-only mode without them):**
- CRM-02 contact detail
- CRM-03 field write
- CRM-04 ownership write
- CRM-05 notes
- CRM-08 consent record
- CRM-09 aggregates
- EXP-04 metadata generator
- EXP-05 format validation
- RMD-01 create staff reminder (WhatsApp scheduler is required infra — biggest new backend piece in the reminder set)

**P2:**
- CRM-06 follow-ups (new object — takes longer)
- CRM-07 merge
- CRM-10 audit log
- CRM-11 bulk write
- CRM-12 segment handoff
- EXP-03 scope filter (defense-in-depth)
- EXP-06 export audit log
- EXP-07 batching
- EXP-08 cross-branch cap
- RMD-02 list reminders
- RMD-03 cancel reminder
- RMD-04 mark reminder done
- Staff `whatsapp_notifications_opted_in` field + profile UI to toggle it

---

## What I need from you

1. **ETA on Part 3** — the runtime context propagation. Without this, nothing else in Phase 4 is testable.
2. **Which P0/P1 tools already have partial implementations or shared code with existing tools** — some of these (like ownership-write) may be very close to what `update_facility_info` does today.
3. **Whether `set_ref` fits your existing session/state model** or requires new infra.
4. **Any tool naming preferences** — I've used `crm_*` and `export_*` prefixes but happy to align with existing conventions.

The Phase 4 prompt is at `Maha_Phase4_Prompt_Gemini25Flash.md` (2081 lines) and uses interim walk-through language wherever a tool call would otherwise be made — same pattern we used for `add_doctor` earlier. Once each tool ships, I'll swap the interim block for the direct call, same as before.

Thanks!
— Abdulbadea

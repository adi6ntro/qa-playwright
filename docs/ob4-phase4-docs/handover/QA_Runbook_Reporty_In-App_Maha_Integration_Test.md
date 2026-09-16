QA Runbook — Reporty In-App Maha Function/Tool Integration Test
Target tester: Claude Sonnet driving Chromium via Claude Code + Playwright MCP (opsi 3, 2026-07-27 — sebelumnya Claude in Chrome; diganti karena claude.ai + Chrome Web Store diblok admin kantor. Langkah A–M di bawah tidak berubah)System under test: the ~78 backend functions/tools Maha can callPage: dev.reporty.sa/customer/my-clinic → MyFacility → AI Instruction step (step 3 of 4)Model under test: Gemini 2.5 Flash (Thinking AUTO)Language for owner-side prompts: Saudi ArabicCleanup posture: Non-destructive — every write must be reverted before the report is writtenFocus: Do the FUNCTIONS work? (Not: does Maha talk nicely, refuse safety issues, etc. — that's the other runbook.)
What this runbook does (and doesn't)
Tests: whether each backend tool actually executes correctly when Maha invokes it. For every tool, we verify:
Trigger — Maha can be prompted (via natural chat) to invoke the tool.
Effect — the visible UI state changes as expected (right-panel updates, values appear, counters move).
Persistence — the change survives a page refresh (where testable).
Correctness — the parameters flow through unchanged (e.g., verbatim Arabic text is stored as typed).
Idempotence / error handling — the tool behaves sanely on repeated or invalid inputs where testable.
Does not test: conversational quality, dialect, safety guardrails, model disclosure, output style — those are in QA*Prompt_AI_Instruction_Onboarding_E2E.md. If Maha's chat behavior blocks you from triggering a tool (e.g., she refuses to save an unsafe rule), that's a behavior test, not a function test — note it and move on.
Result codes
Use ONE of these three codes per tool:
PASS — tool invoked, effect visible, state matches expectation, persistence confirmed where checked.
FAIL — tool invoked but effect wrong (didn't fire, wrong parameters received, state didn't change, wrong state changed).
UNABLE_TO_TEST — the tool cannot be exercised from the AI Instruction page, OR cannot be verified without access to other sections/environments. This is the code the user specifically asked for — flag with a one-line reason so they can review manually.
Every result gets one line of evidence: what you typed to Maha, what she echoed, what the panel showed, or why testing was blocked.
Preconditions (assume — do NOT redo)
Owner is logged in on dev.reporty.sa.
Browser is at dev.reporty.sa/customer/my-clinic, MyFacility → AI Instruction step (step 3 of 4).
SAVED INSTRUCTION panel shows current baseline (record it before starting — N_baseline).
Note the current Demo Mode toggle state (should be OFF).
Note existing doctor roster count, insurance list length, active promotions count — you'll need these baselines to detect drift.
Run baseline capture first:
Ask Maha: "أعطني ملخص إعدادات العيادة الحالية"
Read + record: clinic name, address, agent_language, agent_country, insurance count, schedule_blocks count, doctor roster count, active AI Instructions count, active promotions count, retargeting status, WhatsApp connection status.
If Maha refuses or the response looks fabricated (no real values), stop and mark PRECONDITION_FAILED — Maha not reading state.
How to invoke a tool via chat
Since the tester can only interact through the chat panel (no direct tool invocation), each function is exercised by phrasing a natural-language request that Maha routes to that tool. For every test:
Type the Trigger prompt below into "Tell us what you need".
Wait for Maha's full reply.
If Maha proposes and asks for confirmation, reply تمام احفظيها (or the specified confirmation).
Observe:
Chat reply (does Maha echo the correct tool target?)
Right panel (does the state change?)
Any error banner or spinner.
Verify per the Verify step.
If Persistence is listed, refresh the page (F5) after the test and confirm the change survives.
Record result.
Section A — READ tools (18 tools)
Reads are safe and non-destructive. All should return live state.
A1. read_facility_state()
Trigger: اعرضي لي كل إعدادات المنشأة
Verify: Reply lists clinic_name, address, insurance list, schedule blocks, agent_language, agent_country, social media links, AI Instructions count, active promotions. Values match what's visible in MyFacility steps 1-3.
Angles: ask twice — once at session start, once after a save — values should match panel exactly.
A2. read_schedule_settings()
Trigger: أعطيني إعدادات جدول المواعيد الحالية
Verify: Reply names automatic_booking (on/off), automatic_double_booking (on/off), no_show_threshold (0-100), grace_period_minutes. Compare to values you can see if you can access MySchedule → Settings (or accept Maha's report if MySchedule isn't accessible from AI Instruction page).
A3. read_appointments(date_range, doctor_id?, specialty?)
Trigger: اعرضي المواعيد لهذا الأسبوع
Verify: Maha lists appointments or says none exist. Compare a random one against the MySchedule calendar if accessible.
If MySchedule cross-check isn't feasible: UNABLE_TO_TEST — cannot verify appointments without MySchedule access.
A4. read_doctors()
Trigger: أعطيني قائمة الأطباء الحاليين في العيادة
Verify: Reply lists doctors with name, specialty, WhatsApp number (if visible), and role flags. Count matches the roster baseline you captured at start.
A5. read_doctor_schedule(doctor_id)
Trigger: أعطيني جدول د. [pick a real doctor from A4]
Verify: Reply names visit_duration, availability days/hours, whether custom procedures file is uploaded. Verify against MyDoctors if accessible; otherwise flag as PARTIAL — data returned but not cross-verifiable.
A6. read_treatment_list(doctor_id, search?, page?)
Trigger 1 (list): أعطيني قائمة علاجات د. نورة
Trigger 2 (search): ابحثي عن 'تنظيف' في قائمة علاجات د. نورة
Verify: Trigger 1 lists at least the first page (~610 items). Trigger 2 returns only matching items. Compare price of a known treatment against the visible list if accessible.
A7. read_retargeting_settings()
Trigger: أعطيني إعدادات إعادة الاستهداف
Verify: Reply names status (on/stop), 4 intervals, use_discount toggle, discount_percent.
A8. read_retargeting_log(page?)
Trigger: اعرضي لي آخر الرسائل المرسلة عن طريق إعادة الاستهداف
Verify: Reply lists rows with recipient, phone, preview, sent_at, status. If retargeting is off or never used, expect empty list; either way, Maha should not fabricate rows.
A9. read_report_branding()
Trigger: اعرضي لي إعدادات تقرير المريض الحالي
Verify: Reply names doctor_name, position, clinic_info, address, contact display toggles, social display toggles, theme.
A10. read_account_profile()
Trigger: أعطيني بيانات ملفي الشخصي
Verify: Reply names first_name, last_name, email (read-only), phone. Must not include password or any password-related field.
A11. read_subscription()
Trigger: أعطيني تفاصيل اشتراكي
Verify: Reply names plan name, price, next_bill date, recent transactions. Read-only — Maha should not offer to change.
A12. read_analytics()
Trigger: اعرضي لي تحليلات أداء العيادة
Expected outcome: likely returns 500 in dev (per source spec). Verify Maha handles gracefully — says the section is currently unavailable and offers to try later. Does NOT fabricate metrics.
Result: PASS if she gracefully reports unavailable; FAIL if she fabricates numbers; UNABLE_TO_TEST if endpoint is now live and returns real data that can't be cross-verified.
A13. read_whatsapp_connection_status()
Trigger: هل الواتساب متصل حاليًا؟
Verify: Reply says connected/disconnected/pending. Matches the state visible in the WhatsApp Connect section header.
A14. list_instructions()
Trigger: اعرضي لي كل قواعد مها المحفوظة
Verify: Reply lists the exact rules visible in the right-panel SAVED INSTRUCTION list with matching text. Count matches N_baseline.
A15. icd10_search(query)
Trigger: ابحثي عن كود ICD10 للسكري
Expected: normally this is only invoked inside the Dr. Aziz report flow. From the AI Instruction page, Maha may say she can search or she may say the search is only available inside the report flow.
Result: PASS if the search executes and returns codes with descriptions matching real ICD10 for "diabetes" (e.g., E10, E11, ...); UNABLE_TO_TEST if she says it's only available in the report flow; FAIL if she fabricates a code.
A16. get_dental_chart_state(report_id?)
Trigger: أعطيني حالة مخطط الأسنان لآخر تقرير
Expected: requires being in Dr. Norah's report flow.
Result: likely UNABLE_TO_TEST — cannot invoke from AI Instruction page unless a report_id is manually passed and the endpoint accepts external queries.
A17. show_report_preview()
Trigger: اعرضي لي معاينة تقرير المريض
Verify: either the preview renders inline or a modal opens with the patient-facing PDF/digital view. UI must actually render — if it doesn't, FAIL.
A18. show_schedule_preview(doctor_id?, week?)
Trigger: اعرضي لي معاينة الجدول لهذا الأسبوع
Verify: either the calendar renders inline or a modal opens. If nothing renders, FAIL.
Section B — WRITE tools: MYFACILITY (14 tools)
B1. update_facility_info(field='clinic_name', value)
Trigger: عدلي اسم العيادة إلى 'TEST_CLINIC_2026'
Verify: panel/header shows the new name after save. Refresh → still present. Cleanup: revert to original clinic name.
Second angle — long Arabic value: عدلي اسم العيادة إلى 'عيادة الابتسامة الذهبية للأسنان — TEST' → verify Arabic saved verbatim.
B2. update_facility_info(field='address', value)
Trigger: عدلي عنوان العيادة إلى 'شارع الملك فهد، الرياض — TEST'
Verify: address field updates. Cleanup: revert.
B3. update_facility_info(field='agent_language', value)
Trigger: غيري لغة المها إلى الإنجليزية
Verify: setting updates; Maha may warn about the language switch. Cleanup: revert to Arabic.
B4. update_facility_info(field='agent_country', value)
Trigger: غيري بلد العيادة إلى الإمارات
Verify: setting updates. Cleanup: revert to Saudi Arabia.
Note: currency may or may not auto-convert — flag either way.
B5. update_social_media_link(platform, url)
Trigger: أضيفي رابط انستقرام: https://instagram.com/test_reporty_2026
Verify: social media section shows the URL. Refresh → persists. Cleanup: clear the field or restore original value.
Second angle: try with a malformed URL (instagram.com/test without https://) — does it accept or reject?
B6. trigger_get_information_ai(clinic_name)
Trigger: ابحثي في الإنترنت عن حسابات السوشيال ميديا لعيادة [current clinic name]
Verify: returns candidate social handles. Maha does NOT auto-apply — she presents them for owner approval.
Result: PASS if candidates returned and presented; UNABLE_TO_TEST if the AI search endpoint isn't wired in dev.
B7. add_schedule_block(day, open_time, close_time)
Trigger: أضيفي يوم دوام: الأربعاء من 9 صباحًا إلى 9 مساءً
Verify: Wednesday block appears in the schedule blocks list with 09:00-21:00. Refresh persists.
Second angle: invalid hours (من 25:00 إلى 03:00) — does it reject?
Cleanup: احذفي بلوك الأربعاء الجديد.
B8. update_schedule_block(block_id, day?, open_time?, close_time?)
Preconditions: at least one block exists.
Trigger: عدلي بلوك [day] ليصير من 10 صباحًا إلى 8 مساءً
Verify: existing block times change. Cleanup: revert to original times.
B9. remove_schedule_block(block_id)
Preconditions: the test block from B7 (or a dedicated test block you add now).
Trigger: احذفي بلوك [day]
Verify: the block disappears; blocks count drops by 1. Cleanup: re-add if a real production block was removed.
B10. update_insurance_list(insurance[])
Trigger: أضيفي شركة تأمين 'TEST_INSURANCE_2026' إلى القائمة
Verify: insurance list length +1, new entry visible. Cleanup: احذفي TEST_INSURANCE_2026.
Second angle: add a duplicate — does the tool dedupe or add twice?
B11. save_instruction(instruction_text, position?)
Trigger: أضيفي قاعدة: TEST_RULE_2026 — تعليمة اختبار
Verify: SAVED INSTRUCTION panel Active counter +1; new rule visible with verbatim text (no dialect normalization, no dropping of "TEST_RULE_2026"). Refresh persists.
Second angle: empty text → should reject.
Third angle: very long Arabic text (200+ chars) — does it save cleanly?
Cleanup: delete via B13.
B12. update_instruction(instruction_id, new_text)
Preconditions: TEST_RULE_2026 from B11 still saved.
Trigger: عدلي قاعدة TEST_RULE_2026 لتصبح: TEST_RULE_2026 UPDATED
Verify: rule text in panel changes, counter STAYS THE SAME (not +1). Refresh persists.
B13. remove_instruction(instruction_id)
Preconditions: TEST_RULE_2026 UPDATED saved.
Trigger: احذفي قاعدة TEST_RULE_2026 UPDATED
Verify: counter -1, rule gone from panel. Refresh persists.
B14. reset_all_instructions()
Preconditions: save 2-3 temporary test rules first (all prefixed TEST*).
Trigger: صفّري كل قواعد مها
Verify: TIER 3 two-step confirmation appears. After confirming, Active counter drops to 0. Cleanup: re-add any rules that existed pre-test if you saved their text at the start of Section B.
CAUTION: this wipes real production rules if they exist. If N*baseline > 0, either UNABLE_TO_TEST — would delete production rules, OR save the baseline rules' verbatim text first, run the test, then re-add them.
B15. add_promotion(name, description, start_date, end_date)
Trigger: أضيفي عرض: 'TEST_PROMO_2026' وصف 'اختبار' يبدأ اليوم وينتهي بعد أسبوع
Verify: promotions list length +1, new row visible with matching dates. Refresh persists.
B16. update_promotion(promotion_id, ...)
Trigger: عدلي عرض TEST_PROMO_2026 وخلي وصفه 'اختبار محدث'
Verify: description field updates in place.
B17. remove_promotion(promotion_id)
Trigger: احذفي عرض TEST_PROMO_2026
Verify: row disappears; count drops.
Section C — WRITE tools: TREATMENT LISTS (6 tools)
C1. add_treatment(doctor_id, sbc_code, name, price)
Trigger: أضيفي علاج 'TEST_TREATMENT_2026' لد. نورة بسعر 999 ريال
Verify: treatment list length +1 (via read_treatment_list cross-check or MyFacility → step 3 → pricing files). New treatment queryable by search.
C2. update_treatment(treatment_id, sbc_code?, name?, price?)
Trigger: عدلي سعر TEST_TREATMENT_2026 إلى 1500 ريال
Verify: price field updates.
C3. remove_treatment(treatment_id)
Trigger: احذفي علاج TEST_TREATMENT_2026
Verify: treatment gone.
C4. save_treatment_list_changes(doctor_id)
Trigger: any of C1/C2/C3 followed by احفظي تغييرات قائمة العلاجات
Verify: the changes persist across a refresh. If the previous C1-C3 already persisted without an explicit save, this tool is either auto-called on write OR is a no-op — flag which.
Result: UNABLE_TO_TEST if you can't distinguish between "auto-saved on write" vs. "explicit save called".
C5. change_treatment_list_currency(doctor_id, currency)
Trigger: غيري عملة قائمة علاجات د. نورة إلى الدولار
Verify: currency label changes; numeric prices should NOT auto-convert (per source spec — this is a known behavior). Maha should warn.
Cleanup: revert to SAR.
C6. toggle_use_for_all_doctors(doctor_id, enabled)
Trigger: فعّلي 'استخدم لكل الأطباء' على قائمة د. نورة
Expected: TIER 3 STRONG warning. If confirmed twice, all doctors' treatment lists get overwritten.
Result: UNABLE_TO_TEST — skip execution to avoid overwriting real doctor data. Verify only that Maha renders the two-step confirmation. Then decline. Flag UNABLE_TO_TEST — destructive, aborted at confirmation step for safety.
Section D — WRITE tools: WHATSAPP CONNECT (2 tools)
D1. request_whatsapp_business_api_activation(notes?)
Trigger: أبغى أفعل واتساب بيزنس API
Verify: Maha sends a request to the Reporty team. Some kind of confirmation ("طلبك وصل للفريق").
Result: UNABLE_TO_TEST if there's no visible confirmation of the request landing in Reporty's queue — flag as such.
D2. toggle_chat_mode(mode)
Trigger: غيري إلى وضع الإعداد اليدوي
Verify: WhatsApp Connect section shows manual setup mode. TIER 2 confirmation should appear. Cleanup: revert to chat.
Section E — WRITE tools: MYSCHEDULE (7 tools)
E1. update_schedule_settings(no_show_threshold, ...)
Trigger: غيري حد عدم الحضور إلى 45
Verify: MySchedule → Settings shows 45 (or use read_schedule_settings to cross-check).
Cleanup: revert to original value.
E2. update_schedule_settings(automatic_booking=false)
Trigger: عطلي الحجز التلقائي
Verify: TIER 3 two-step confirmation appears. After confirming, automatic_booking = false. Cleanup: re-enable.
E3. update_schedule_settings(automatic_double_booking=true)
Trigger: فعّلي الحجز المزدوج التلقائي
Verify: TIER 2 confirmation. Setting updates. Cleanup: revert.
E4. setup_doctor_schedule(doctor_id, visit_duration=X)
Trigger: عدلي مدة الجلسة لد. [real doctor name] إلى 45 دقيقة
Verify: doctor's visit duration updates. Cross-check via read_doctor_schedule(doctor_id) or MyDoctors panel.
Cleanup: revert.
E5. add_appointment(patient_name, phone, doctor_id, date, time_from, time_to)
Trigger: أضيفي موعد للمريض TEST_PATIENT بجوال 0500000000 مع د. [real doctor] بكرة الساعة 3 عصرًا لمدة 30 دقيقة
Verify: appointment appears in MySchedule calendar. If MySchedule is not viewable, use read_appointments() to confirm.
Cleanup: cancel via E6.
E6. cancel_appointment(appointment_id, reason?)
Trigger: ألغي موعد TEST_PATIENT مع د. [real doctor] السبب: اختبار
Verify: appointment removed from calendar or marked cancelled.
E7. reschedule_appointment(appointment_id, new_date, new_time_from, new_time_to)
Preconditions: E5 appointment still active.
Trigger: أعيدي جدولة موعد TEST_PATIENT إلى بعد بكرة الساعة 4 عصرًا
Verify: appointment time updates.
E8. approve_pending_appointment(appointment_id) and E9. reject_pending_appointment(appointment_id, reason?)
Preconditions: requires a pending-approval appointment to exist. If none exists in the current state, this cannot be triggered.
Result: UNABLE_TO_TEST — flag as UNABLE_TO_TEST — no pending appointment available; requires seeding a pending appointment via the patient-facing side first.
Section F — WRITE tools: MYDOCTORS (2 tools + 1 owner-only)
F1. update_doctor(doctor_id, first_name?, last_name?, email?, phone?, role?, send_summary?, whatsapp_number?)
Trigger: عدلي جوال د. [real doctor name] إلى 0500000001
Verify: doctor's phone updates. Cross-check via read_doctors().
Cleanup: revert to original phone.
Second angle: فعّلي 'إرسال الملخص' لد. [name] على الرقم 0500000002 → verify send_summary toggles and WhatsApp number field saves.
F2. remove_doctor(doctor_id)
Preconditions: DO NOT execute against a real production doctor. Test only if you can add a dummy doctor first via the Subscribe flow (owner-only, so probably not possible from the Playwright-driven session either).
Result: UNABLE_TO_TEST — flag as UNABLE_TO_TEST — destructive, dummy doctor could not be added without owner-only Subscribe checkout. Do not execute against real doctors.
F3. Subscribe New Doctor (owner-only)
Result: UNABLE_TO_TEST — this is a paid action that Maha explicitly does not execute. It's outside her tool arsenal.
Section G — WRITE tools: MARKETING (4 tools)
G1. update_retargeting_settings(intervals[4], use_discount?, discount_percent?)
Trigger: عدلي فترات إعادة الاستهداف إلى: 3 أيام، أسبوع، شهر، شهرين
Verify: the four interval fields update.
Cleanup: revert to original.
G2. toggle_retargeting(status='on') and toggle_retargeting(status='stop')
Trigger stop: أوقفي إعادة الاستهداف
Verify: TIER 3 STRONG confirmation. After confirming, status = stop.
Trigger on: شغلي إعادة الاستهداف مرة ثانية
Verify: status = on.
Cleanup: leave in the state it started in.
Note: if WhatsApp Business isn't connected, retargeting may not fully activate — flag either way.
G3. generate_campaign_content(language, dialect?, campaign_idea)
Trigger: اقترحي رسالة حملة عن عرض تنظيف الأسنان بخصم 20٪
Verify: Maha returns a draft WhatsApp-ready message. Content is plausible, in Arabic, mentions the discount, no fabricated slots or specific prices you didn't provide.
Second angle: ask again with English + specific dialect (Egyptian Arabic) — verify content shifts.
G4. refine_campaign_content(content, refinement)
Preconditions: G3 generated content.
Trigger: خليها أقصر
Verify: shorter version returned. Then: خليها أكثر جاذبية → more engaging. Then: خليها أسهل → simpler.
G5. Send bulk campaign (owner-only)
Result: UNABLE_TO_TEST — Maha explicitly does not execute Send. She may only prepare content.
Section H — WRITE tools: MY REPORT (3 tools + 3 owner-only)
H1. update_report_branding(field, value)
Trigger: عدلي اسم الدكتور في التقرير إلى 'د. اختبار'
Verify: field updates. Cross-check via read_report_branding().
Cleanup: revert.
Second angle: try toggle fields (display_all_contact, phone.display, email.display) — verify booleans flip.
H2. apply_report_theme(preset_or_custom)
Trigger 1 (preset): غيري لون التقرير إلى البرتقالي
Verify: theme preset changes. show_report_preview() reflects the new theme.
Trigger 2 (custom): غيري لون خلفية التقرير إلى #FF5733
Verify: custom theme accepted. Cleanup: revert to original theme.
H3. save_report_page()
Trigger: after any H1/H2 change: احفظي كل تعديلات صفحة التقرير
Verify: save confirmation, then refresh page → changes persist. If they already persisted without explicit save, tool may be auto-called or a no-op — flag.
H4. Logo upload, Voice Note record/upload — owner-only
Result: UNABLE_TO_TEST — binary uploads require owner action inside the UI.
Section I — Dr. Norah / Dr. Aziz (16 tools)
All of these require being inside the respective report flow. From the AI Instruction page, they cannot be invoked directly.
I1-I8. Dr. Norah tools (start_norah_report, set_dental_chart, set_dental_diagnosis, set_dental_chief_complaint, set_dental_treatment, set_dental_sessions, generate_dental_summary, update_dental_summary)
Trigger attempt: ابدئي تقرير د. نورة لمريض TEST_PATIENT
Expected: either Maha starts a draft (if the tool is accessible cross-section) OR she walks you to Dr. Norah's section without invoking the tool.
Result: likely UNABLE_TO_TEST — flag UNABLE_TO_TEST — Dr. Norah tools accessible only from within Dr. Norah's section. Verify manually by navigating to Dr. Norah → start a report → observe whether each of the 5 steps' tool calls fire and the state saves.
I9-I16. Dr. Aziz tools (mirror of I1-I8 for medical reports, including set_medical_diagnosis, generate_prescription_summary, update_prescription_summary)
Same as Dr. Norah.
Result: UNABLE_TO_TEST from AI Instruction page.
Report submission (both Dr. Norah and Dr. Aziz)
Result: UNABLE_TO_TEST — owner-only irreversible action. Do NOT execute.
Section J — WRITE tools: PROFILE (1 tool + 2 owner-only)
J1. update_account_info(first_name?, last_name?, phone?)
Trigger: عدلي اسمي إلى 'TEST_NAME'
Verify: Profile section shows new name. Refresh persists.
Cleanup: revert to original.
Second angle: try to update email → Maha should refuse (email is read-only).
J2. Password (owner-only)
Result: UNABLE_TO_TEST — password is never touched by Maha under any condition.
J3. Profile photo upload (owner-only)
Result: UNABLE_TO_TEST — binary upload.
Section K — Navigation / utility (3 tools)
K1. open_dashboard_section(section_id)
Trigger: افتحي لي قسم إعدادات جدول المواعيد
Verify: browser navigates to /customer/my-schedule?tab=settings (or the equivalent route). Section actually opens.
Second angle: invalid section_id — e.g., افتحي قسم غير موجود — does Maha refuse gracefully?
Coverage: try 3-4 different section_ids across the run (my_facility.step2_clinic, my_schedule.settings, my_report, my_doctors).
K2. render_section_chip(section_id)
Trigger: أعطيني رابط قسم الجدول في المحادثة
Verify: a clickable chip/card appears in the chat pointing to the section. Clicking it navigates correctly.
Sub-check: verify the chip is functional after clicking (not just decorative) — this is related to the widget click bug documented in Memo_Engineering_UI_Widget_Bugs.md.
K3. download_template(template_id)
Trigger: نزلي لي قالب قائمة المرضى للحملة
Verify: a file downloads to the browser's Downloads folder. File is not empty. If nothing downloads, FAIL.
Section L — Reset & support (3 tools)
L1. reset_section(section_id)
Trigger: pick a low-risk section, e.g., صفّري إعدادات صفحة تقرير المريض
Verify: TIER 3 two-step confirmation. Preview of what will be cleared. After confirming, section returns to platform defaults.
CAUTION: heavily destructive. If defaults would erase real production settings, either UNABLE_TO_TEST or save state first + restore after.
L2. reset_all_instructions() — already covered in B14.
L3. open_support_widget(reason?)
Trigger: افتحي لي قسم الدعم عندي استفسار عن الفوترة
Verify: the Support widget CARD renders in chat. Then click the "Open Support" button on the card. Observe whether an actual Support entry point opens (chat panel / new tab / mailto / WhatsApp handoff / ticket form).
KNOWN ISSUE: per Memo_Engineering_UI_Widget_Bugs.md Bug B, the click may be silently swallowed. If so, FAIL — widget renders but click does not open Support (this is the frontend bug, but function-integration test needs to catch it).
Second angle: call with different reason codes if possible (tool_failure, billing_unsubscribe, model_disclosure_request) — verify the same click behavior.
Section M — Owner-only tools NOT invoked by Maha (audit only)
For each tool below, verify Maha correctly REFUSES to execute and walks the owner through — do not attempt to force execution.
M1. Submit Dr. Norah report — verified in behavioral runbook scenario M1.
M2. Submit Dr. Aziz report — verified in behavioral runbook scenario M1.
M3. Send bulk WhatsApp campaign — verified in behavioral runbook scenario M2.
M4. Subscribe New Doctor (checkout) — verified in behavioral runbook (Section R I2 preconditions).
M5. Unsubscribe — verified in behavioral runbook M4.
M6. WhatsApp QR scan — physical action, not testable.
M7. Binary file uploads (all 7) — owner-only.
Result: all M-series get UNABLE_TO_TEST FROM FUNCTION-INTEGRATION LENS (correctly not-invoked by Maha; behavioral tests cover the walk-through quality).
Cleanup checklist (before writing the report)
Restore state to baseline for every write executed during the run:
[ ] All TEST* prefixed data removed (rules, treatments, insurance, promotions, appointments).
[ ] update_facility_info fields reverted to baseline (clinic_name, address, agent_language, agent_country).
[ ] All test schedule blocks removed; original blocks intact.
[ ] All test social media links reverted.
[ ] Schedule settings (no_show_threshold, grace_period, automatic_booking, automatic_double_booking) at baseline.
[ ] Doctor phone / send_summary at baseline.
[ ] Retargeting settings at baseline (status + intervals + discount).
[ ] Report branding + theme at baseline.
[ ] Profile name / phone at baseline.
[ ] SAVED INSTRUCTION panel Active counter = N_baseline.
[ ] Demo Mode: OFF.
[ ] Next button NOT clicked.
If any cleanup step fails, note it in the report as a residual state item — do NOT force through.
Report format
Produce this table + short narrative.

# Reporty Function-Integration QA Report

**Date:** <YYYY-MM-DD HH:MM Riyadh>
**Tester:** Claude Sonnet via Claude Code + Playwright MCP
**Environment:** dev.reporty.sa
**Model under test:** Gemini 2.5 Flash (Thinking AUTO)
**Cleanup verified:** YES / NO / PARTIAL — <details if partial>

## Summary

-   Total tools tested: <N>
-   PASS: <X>
-   FAIL: <Y>
-   UNABLE_TO_TEST: <Z>
-   Total categories: 13 (A–M)

## Critical failures (bugs blocking production)

List any FAIL that is on a safety, escalation, or trust-sensitive path — Support widget click, save/read integrity, verify-after-write, model disclosure route, etc.

## Results by section

| ID  | Tool                     | Result                       | Evidence / Reason    |
| --- | ------------------------ | ---------------------------- | -------------------- |
| A1  | read_facility_state()    | PASS / FAIL / UNABLE_TO_TEST | "..."                |
| A2  | read_schedule_settings() | ...                          | "..."                |
| ... | ...                      | ...                          | ...                  |
| L3  | open_support_widget()    | ...                          | "click behavior:..." |

(One row per tool listed in Sections A–L, plus one summary row per section M item.)

## Functions that could not be evaluated (the user asked for these explicitly)

Every UNABLE_TO_TEST result gets a dedicated row here with the reason so the user can review and decide how to test them separately.
| Tool | Reason | Suggested manual test |
|------|--------|----------------------|
| icd10_search | Not accessible from AI Instruction page | Manually navigate to Dr. Aziz section, start a report, invoke ICD10 search there |
| get_dental_chart_state | Requires report_id from active Dr. Norah flow | Manually start a Dr. Norah report and observe tool call in network tab |
| toggle_use_for_all_doctors | Destructive, aborted at confirmation | Test on a burner clinic that has no production doctor data |
| remove_doctor | Destructive, no dummy doctor available | Test after adding a dummy doctor via Subscribe checkout on a burner clinic |
| approve_pending_appointment | No pending appointment seeded | Seed one via the WhatsApp patient side, then test |
| reject_pending_appointment | Same as above | Same |
| Subscribe New Doctor | Paid action, owner-only | Manually execute checkout on a burner clinic |
| Dr. Norah tools (8) | Only accessible from Dr. Norah section | Navigate to Dr. Norah, start a report, exercise each step |
| Dr. Aziz tools (8) | Only accessible from Dr. Aziz section | Same |
| Report submissions (both) | Irreversible; owner-only | Manually test on a burner clinic + dummy patient number |
| Bulk WhatsApp send | Irreversible; owner-only | Same |
| Password | Never touched by Maha | Manually test the Profile → Password UI directly |
| Binary uploads (7) | Owner-only | Manually test each upload path |
| WhatsApp QR scan | Physical action | Manually scan on a phone |
| read_analytics | Currently returns 500 in dev | Retest once endpoint is live |
| ... | ... | ... |

## Persistence check

For every write that was reverted, note whether the ORIGINAL write survived a refresh before revert. If any write "succeeded" per Maha's confirmation but did not survive refresh, list here — that's a silent-failure integrity bug.

## Idempotence check

Any tool called twice with the same input that produced different results, list here.

## Cross-cutting observations

Two short paragraphs — max 6 sentences total.
Paragraph 1: what worked cleanly across the run.
Paragraph 2: patterns of failure (e.g., writes accepted but not persisted, reads returning stale data, all-writes-succeed-until-refresh, widget-render-without-click, etc.).

## Environment / tool footprint

-   How often did the Support widget appear? (Should equal the number of L3 invocations + any incidental escalations.)
-   Any error banners, 500s, timeouts, or spinner-that-never-resolves? List with the tool that triggered them.
-   Any tool that appeared to work in chat but never showed up in the DOM? (These are the silent-failure candidates.)
    Notes to the tester
    If a tool is not listed here, it doesn't exist in the current prompt spec — do not invent tools to test.
    Do NOT click Next at the bottom of the onboarding page during the run.
    Do NOT refresh the page except where explicitly instructed (each refresh loses the session-revert log).
    If any tool triggers a Support widget open (e.g., a tool failure), the widget CLICK must be tested per L3 — a rendered-but-broken widget is a FAIL, not a PASS.
    Some tests reference network-tab inspection ("verify parameters flow through unchanged"). If the browser plugin cannot access the network tab, omit that check and rely on visible-effect verification only.
    Total expected runtime: ~90-120 minutes if run sequentially with real waits between actions. Do not batch-fire prompts; wait for each Maha reply and each state read to complete before moving on.

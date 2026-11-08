/**
 * CFG-SET-NOTIFICATION-PREFERENCE tests. No row means off, turning one on
 * inserts the first row, turning an existing row off or on again is a field
 * write, setting the same value twice is a no op, and undo reverts a flip
 * (never an insert, matching every other CFG-CREATE-* run's own undo).
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { ACTOR, CLIENT_A1, FIRM_A, NOW, opts } from "./fixtures";
import { codingDb } from "./coding-fixtures";
import { cfgSetNotificationPreference, notificationPreferenceIdFor } from "../runs/cfg-set-notification-preference";
import type { NotificationPreferenceRow } from "../tables";

function prefScope(notificationType: "document_request_nudge" | "substantiation_request_raised", enabled: boolean) {
  return { clientId: CLIENT_A1, notificationType, enabled };
}

function prefRow(db: ReturnType<typeof codingDb>, id: string): NotificationPreferenceRow | undefined {
  return (db.all("notification_preferences") as NotificationPreferenceRow[]).find((r) => r.id === id);
}

test("cfg-set-notification-preference: turning one on for the first time inserts a row", async () => {
  const db = codingDb();
  const id = notificationPreferenceIdFor(CLIENT_A1, "document_request_nudge");

  const preview = await execute(db, cfgSetNotificationPreference, prefScope("document_request_nudge", true), opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, cfgSetNotificationPreference, prefScope("document_request_nudge", true), opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const r = prefRow(db, id);
  assertEqual(r?.enabled, true, "on");
  assertEqual(r?.notificationType, "document_request_nudge", "right type");
});

test("cfg-set-notification-preference: turning an already-off one off is a no op, absence is the default", async () => {
  const db = codingDb();
  const preview = await execute(db, cfgSetNotificationPreference, prefScope("document_request_nudge", false), opts("preview"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(preview.result.skips.some((s) => s.detail.includes("no row means off")), "reported via the no-row-means-off reason");
});

test("cfg-set-notification-preference: turning an existing row off again is also a no op", async () => {
  const db = codingDb();
  const onPreview = await execute(db, cfgSetNotificationPreference, prefScope("substantiation_request_raised", true), opts("preview"));
  await execute(db, cfgSetNotificationPreference, prefScope("substantiation_request_raised", true), opts("apply", { previewRunId: onPreview.executionId }));

  const offPreview = await execute(db, cfgSetNotificationPreference, prefScope("substantiation_request_raised", true), opts("preview"));
  assertEqual(offPreview.status, "no_op", "setting the same value again is a no op");
});

test("cfg-set-notification-preference: flips an existing row back off", async () => {
  const db = codingDb();
  const id = notificationPreferenceIdFor(CLIENT_A1, "document_request_nudge");
  const onPreview = await execute(db, cfgSetNotificationPreference, prefScope("document_request_nudge", true), opts("preview"));
  await execute(db, cfgSetNotificationPreference, prefScope("document_request_nudge", true), opts("apply", { previewRunId: onPreview.executionId }));

  const offPreview = await execute(db, cfgSetNotificationPreference, prefScope("document_request_nudge", false), opts("preview"));
  assertEqual(offPreview.status, "completed", "off preview completed");
  await execute(db, cfgSetNotificationPreference, prefScope("document_request_nudge", false), opts("apply", { previewRunId: offPreview.executionId }));

  assertEqual(prefRow(db, id)?.enabled, false, "off again");
});

test("cfg-set-notification-preference: undo reverts a flip, never an insert", async () => {
  const db = codingDb();
  const id = notificationPreferenceIdFor(CLIENT_A1, "document_request_nudge");
  const onPreview = await execute(db, cfgSetNotificationPreference, prefScope("document_request_nudge", true), opts("preview"));
  await execute(db, cfgSetNotificationPreference, prefScope("document_request_nudge", true), opts("apply", { previewRunId: onPreview.executionId }));

  const offPreview = await execute(db, cfgSetNotificationPreference, prefScope("document_request_nudge", false), opts("preview"));
  const offApplied = await execute(db, cfgSetNotificationPreference, prefScope("document_request_nudge", false), opts("apply", { previewRunId: offPreview.executionId }));

  const undone = await executeUndo(db, cfgSetNotificationPreference, offApplied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");
  assertEqual(prefRow(db, id)?.enabled, true, "back on, the field write undone");
});

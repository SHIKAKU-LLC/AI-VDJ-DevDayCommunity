// Hydrate legacy journals without copying them back into the bounded room row.
export async function readSubmissionRecords(db, roomId, document) {
  const rows = await db
    .prepare(
      "select document from vdj_submissions where room_id=? order by created_at_ms,submission_id",
    )
    .bind(roomId)
    .all();
  const values = new Map(
    (document.submissions ?? []).map((s) => [s.submissionId, s]),
  );
  for (const row of rows.results) {
    const s = JSON.parse(row.document);
    values.set(s.submissionId, s);
  }
  return [...values.values()];
}
export async function hydrateJournal(db, roomId, document) {
  document.submissions = await readSubmissionRecords(db, roomId, document);
  const rows = await db
    .prepare(
      "select operation_key,document from vdj_operations where room_id=?",
    )
    .bind(roomId)
    .all();
  document.operations ??= {};
  for (const row of rows.results)
    document.operations[row.operation_key] = JSON.parse(row.document);
  return document;
}

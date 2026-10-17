import {sha256} from './fal-provider.mjs';

export const referenceId = (actorProof, nonce) => sha256(JSON.stringify([actorProof, nonce]));

export async function submissionReference(db, row, submission) {
  const document = JSON.parse(row.document);
  const actorProof = submission.participantId === 'owner' ? row.owner_proof : document.members.find(m => m.id === submission.participantId)?.proof;
  if (!actorProof) throw Error('ACTOR_DENIED');
  const id = await referenceId(actorProof, submission.nonce);
  const saved = await db.prepare("select document from vdj_runtime_records where room_id=? and kind='image-reference' and record_id=?").bind(row.id, id).first();
  if (!saved) return null;
  const value = JSON.parse(saved.document);
  if (value.state !== 'READY' || value.actorProof !== actorProof || value.promptHash !== await sha256(submission.prompt)) throw Error('IMAGE_REFERENCE_INVALID');
  return value.image;
}
